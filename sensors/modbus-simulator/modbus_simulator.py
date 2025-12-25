#!/usr/bin/env python3
"""
Generic Modbus TCP Simulator
Supports multiple slave IDs with vendor-specific data points loaded from API or JSON.

Architecture:
- Dedicated simulation threads update register values continuously at 1Hz
- getValues() performs pure reads (no side effects)
- O(1) data point lookups via pre-indexed dictionary
- Hot-swap profile support with automatic index rebuilding

Environment Variables:
- MODBUS_PROFILE: name of the profile to simulate (default: 'Generic')
- MODBUS_API_URL: API URL to fetch profile data (default: 'http://api:3002')
- MODBUS_PROFILE_JSON: fallback path to JSON file (default: './profiles/dataPoints.json')
- MODBUS_SLAVES: number of slave IDs to simulate (default: 3)
- MODBUS_PORT: TCP port to listen on (default: 502)
- LOG_LEVEL: logging verbosity (DEBUG for per-register details, INFO for summaries)
"""
import logging
import time
import random
import os
import json
import urllib.request
import threading
from pymodbus.server import StartTcpServer
from pymodbus.device import ModbusDeviceIdentification
from pymodbus.datastore import ModbusSequentialDataBlock, ModbusSlaveContext, ModbusServerContext
from pymodbus.pdu import ExceptionResponse
from pymodbus.exceptions import NoSuchSlaveException

# Configure logging level from environment (default: INFO)
log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, log_level, logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)
logger.info(f"Logging level set to: {log_level}")

# Configuration
PROFILE = os.environ.get("MODBUS_PROFILE", "Generic")
API_URL = os.environ.get("MODBUS_API_URL", "http://api:3002")
JSON_FILE = os.environ.get("MODBUS_PROFILE_JSON", "./profiles/dataPoints.json")

# Load profile data from API or fallback to file
def load_profile_data():
    """Load profile data points from API, fallback to local file"""
    # Try API first (with retries)
    max_retries = 3
    retry_delay = 2  # seconds
    
    for attempt in range(max_retries):
        try:
            url = f"{API_URL}/api/v1/profiles/datapoints?protocol=modbus"
            logger.info(f"Fetching profile data from API: {url} (attempt {attempt + 1}/{max_retries})")
            
            req = urllib.request.Request(url, headers={'User-Agent': 'modbus-simulator/1.0'})
            with urllib.request.urlopen(req, timeout=5) as response:
                profile_data = json.loads(response.read().decode())
                logger.info(f"✓ Loaded profile data from API ({len(profile_data)} profiles)")
                return profile_data
        except Exception as e:
            if attempt < max_retries - 1:
                logger.warning(f"API attempt {attempt + 1} failed: {e}, retrying in {retry_delay}s...")
                time.sleep(retry_delay)
            else:
                logger.warning(f"Failed to load from API after {max_retries} attempts: {e}")
    
    # Fallback to file
    try:
        logger.info(f"Falling back to local file: {JSON_FILE}")
        with open(JSON_FILE, "r") as f:
            profile_data = json.load(f)
            logger.info(f"✓ Loaded profile data from file ({len(profile_data)} profiles)")
            return profile_data
    except Exception as e:
        logger.error(f"Failed to load profile data from file '{JSON_FILE}': {e}")
        return {}

profile_data = load_profile_data()

# Global profile index cache: {profile_name: {(type, address): datapoint}}
# Built once at startup, shared by all ProfileDataBlock instances
# Reduces 4x redundant indexing (HR, IR, CO, DI) to 1x per profile
def build_profile_index(profile_name: str) -> dict:
    """Build O(1) lookup index for a profile's data points"""
    profile_obj = profile_data.get(profile_name, {})
    logger.debug(f"[DEBUG] build_profile_index('{profile_name}'): profile_obj type={type(profile_obj)}, keys={list(profile_obj.keys()) if isinstance(profile_obj, dict) else 'N/A'}")
    data_points = profile_obj.get("dataPoints", [])
    logger.info(f"[DEBUG] Profile '{profile_name}' has {len(data_points)} data points to index")
    index = {}
    for dp in data_points:
        addr = dp.get("address")
        dp_type = dp.get("type", "holding")
        key = (dp_type, addr)
        index[key] = dp
    return index

# Preload indexes for all profiles
PROFILE_INDEX = {
    profile: build_profile_index(profile)
    for profile in profile_data.keys()
}
logger.info(f"Preloaded profile indexes: {list(PROFILE_INDEX.keys())}")

# State file for inter-process communication
STATE_FILE = "/tmp/modbus_simulator_state.json"

def get_active_profile():
    """Read active profile from state file (shared with GUI)"""
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r") as f:
                state = json.load(f)
                return state.get("profile", PROFILE)
    except Exception as e:
        logger.warning(f"Failed to read state file: {e}")
    return PROFILE

def get_data_points():
    """Get data points for active profile"""
    active_profile = get_active_profile()
    return profile_data.get(active_profile, {}).get("dataPoints", [])

# Shared state for GUI overrides (imported by web_gui.py)
try:
    from web_gui import REGISTER_OVERRIDES, DISABLED_SLAVES, SLAVE_DELAYS, REGISTER_ACCESS_LOG, EXCEPTION_INJECTIONS
    logger.info("GUI integration enabled - using shared state")
except ImportError:
    REGISTER_OVERRIDES = {}
    DISABLED_SLAVES = set()  # Set of disabled slave unit IDs
    SLAVE_DELAYS = {}  # {slave_id: {"delay_ms": int, "jitter_ms": int}}
    REGISTER_ACCESS_LOG = {}  # {(slave_id, reg_type, address): {reads: int, writes: int, last_read: float, last_write: float}}
    EXCEPTION_INJECTIONS = {}  # {(slave_id, reg_type, address): exception_code} or {slave_id: exception_code}
    logger.info("GUI not available - running in standalone mode")

class DisableableSlaveContext(ModbusSlaveContext):
    """ModbusSlaveContext that can be disabled to simulate device failure"""
    def __init__(self, unit_id, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.unit_id = unit_id
    
    def validate(self, fx, address, count=1):
        """Override validation to reject requests if slave is disabled"""
        if self.unit_id in DISABLED_SLAVES:
            print(f"[SIMULATOR] Slave {self.unit_id} DISABLED - validate() returning False for fx={fx}", flush=True)
            logger.debug(f"Slave {self.unit_id} is disabled - rejecting request")
            return False  # Validation fails for disabled slaves
        return super().validate(fx, address, count)

class ProfileDataBlock(ModbusSequentialDataBlock):
    """Simulate Modbus registers for any profile with stateful updates"""
    def __init__(self, address, values, register_type='holding', unit_id=1):
        super().__init__(address, values)
        self.start_time = time.time()
        self.register_type = register_type  # 'holding', 'input', 'coil', 'discrete'
        self.unit_id = unit_id  # Track which slave this block belongs to
        self.update_interval = 1.0  # Update stored values every 1 second
        self.last_profile = None  # Track profile changes
        self._stop_simulation = threading.Event()
        
        # Pre-indexed data points for O(1) lookup: {(type, address): datapoint}
        self._dp_index = {}
        self._rebuild_index()
        
        # Initialize registers with realistic values
        self._initialize_registers()
        
        # Start background simulation loop (daemon thread)
        self._sim_thread = threading.Thread(target=self._simulation_loop, daemon=True)
        self._sim_thread.start()
        logger.debug(f"Started simulation thread for {self.register_type} registers (unit {self.unit_id})")
    
    def _rebuild_index(self):
        """Use prebuilt profile index from global cache (O(1) operation)"""
        active_profile = get_active_profile()
        
        # Check if profile exists in cache
        if active_profile not in PROFILE_INDEX:
            logger.warning(f"Profile '{active_profile}' not in cache, rebuilding...")
            PROFILE_INDEX[active_profile] = build_profile_index(active_profile)
        
        # Reference the global cache (shared across all instances)
        self._dp_index = PROFILE_INDEX[active_profile]
        logger.debug(f"{self.register_type} using cached index for {active_profile} ({len(self._dp_index)} data points)")
    
    def _initialize_registers(self):
        """Initialize register values based on vendor data points"""
        for addr in range(self.address, self.address + len(self.values)):
            key = (self.register_type, addr)
            dp = self._dp_index.get(key)
            
            if not dp:
                continue  # No data point configured for this address
            
            idx = addr - self.address
            
            if self.register_type in ['coil', 'discrete']:
                # Initialize boolean registers as False (no alarms/outputs)
                self.values[idx] = False
            else:
                # Initialize numeric registers with base value
                base = dp.get("base", 100)
                noise_pct = dp.get("noise_pct", 0.05)
                self.values[idx] = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
    
    def _simulation_loop(self):
        """Background thread: continuously update register values at fixed interval"""
        logger.info(f"Simulation loop started for {self.register_type} registers (interval={self.update_interval}s)")
        
        while not self._stop_simulation.is_set():
            try:
                # Check for vendor changes and update registers
                self._update_registers()
                
                # Sleep until next update cycle
                self._stop_simulation.wait(timeout=self.update_interval)
            except Exception as e:
                logger.error(f"Error in simulation loop: {e}", exc_info=True)
                time.sleep(self.update_interval)  # Fallback sleep on error
        
        logger.info(f"Simulation loop stopped for {self.register_type} registers")
    
    def stop_simulation(self):
        """Stop the background simulation thread (for cleanup)"""
        self._stop_simulation.set()
        if self._sim_thread.is_alive():
            self._sim_thread.join(timeout=2.0)
    
    def _update_registers(self):
        """Update register values with realistic drift (called periodically)"""
        active_profile = get_active_profile()
        
        # Rebuild global cache if profile changed (hot-swap support)
        if active_profile != self.last_profile:
            logger.info(f"Profile switched: {self.last_profile} → {active_profile}")
            
            # Rebuild profile index in global cache if missing
            if active_profile not in PROFILE_INDEX:
                logger.info(f"Building new profile index for {active_profile}...")
                PROFILE_INDEX[active_profile] = build_profile_index(active_profile)
            
            # Update instance to use new profile's index
            self._dp_index = PROFILE_INDEX[active_profile]
            self.last_profile = active_profile
            logger.info(f"Switched to {active_profile} index ({len(self._dp_index)} data points)")
        
        updates_count = 0
        for addr in range(self.address, self.address + len(self.values)):
            key = (self.register_type, addr)
            dp = self._dp_index.get(key)
            
            if dp:  # DEBUG: Track successful updates
                updates_count += 1
            
            if not dp:
                continue  # No data point configured for this address
            
            idx = addr - self.address
            
            if self.register_type == 'discrete':
                # Discrete Inputs: Read-only status (e.g., alarms, sensor states)
                # Simulate with 5% chance to trigger
                self.values[idx] = bool(random.random() < 0.05)
            
            elif self.register_type == 'coil':
                # Coils: Writable outputs - check for GUI override first
                if addr in REGISTER_OVERRIDES:
                    # GUI can override coil states
                    self.values[idx] = bool(REGISTER_OVERRIDES[addr].get('value', False))
                else:
                    # Default: simulate with 5% chance to be ON
                    self.values[idx] = bool(random.random() < 0.05)
            
            elif self.register_type == 'holding':
                # Holding Registers: Read/write - check for GUI override first
                if addr in REGISTER_OVERRIDES:
                    override = REGISTER_OVERRIDES[addr]
                    base = override.get("base", 100)
                    noise_pct = override.get("noise_pct", 0.05)
                    self.values[idx] = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
                else:
                    # Use vendor config
                    base = dp.get("base", 100)
                    noise_pct = dp.get("noise_pct", 0.05)
                    new_value = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
                    self.values[idx] = new_value
                    # DEBUG: Log specific problematic addresses
                    if addr in [99, 129, 139, 149, 159] and self.unit_id == 1:
                        logger.info(f"[DEBUG] Updated holding[{addr}] idx={idx} value={new_value} (base={base})")
            
            elif self.register_type == 'input':
                # Input Registers: Read-only sensor readings (no GUI overrides)
                base = dp.get("base", 100)
                noise_pct = dp.get("noise_pct", 0.05)
                self.values[idx] = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
        
        # DEBUG: Log update counts periodically
        if updates_count > 0 and self.unit_id == 1 and self.register_type == 'holding':
            logger.debug(f"[{self.register_type}] Updated {updates_count} registers (range {self.address}-{self.address + len(self.values) - 1})")

    def getValues(self, address, count=1):
        """Read stored register values (pure read, simulation thread updates values)"""
        # CRITICAL FIX: pymodbus server adds +1 to incoming addresses (Modbus 1-based protocol)
        # Client sends 99 → server calls getValues(100)
        # We need 0-based addressing, so subtract 1
        address = address - 1
        
        # Reload disabled slaves from shared state file (cross-process communication)
        global DISABLED_SLAVES
        try:
            import json
            if os.path.exists('/tmp/modbus_simulator_state.json'):
                with open('/tmp/modbus_simulator_state.json', 'r') as f:
                    state = json.load(f)
                    DISABLED_SLAVES = set(state.get('disabled_slaves', []))
        except:
            pass
        
        print(f"[GETVALUES ENTRY] unit_id={getattr(self, 'unit_id', 'UNKNOWN')}, addr={address}, count={count}", flush=True)
        
        # CRITICAL: Check if slave is disabled first (simulates device offline/failure)
        print(f"[SIMULATOR DEBUG] getValues called: slave={self.unit_id}, addr={address}, count={count}, DISABLED_SLAVES={DISABLED_SLAVES}", flush=True)
        if self.unit_id in DISABLED_SLAVES:
            print(f"[SIMULATOR] Slave {self.unit_id} DISABLED - Rejecting read for {self.register_type}[{address}:{address+count-1}]", flush=True)
            logger.warning(f"Slave {self.unit_id} is disabled - rejecting read request for {self.register_type}[{address}:{address+count-1}]")
            # Return empty list to trigger Modbus exception
            return []
        
        # Check for register-specific exception injection
        for i in range(count):
            addr = address + i
            exception_key = (self.unit_id, self.register_type, addr)
            if exception_key in EXCEPTION_INJECTIONS:
                exception_code = EXCEPTION_INJECTIONS[exception_key]
                logger.warning(f"Exception injection: slave {self.unit_id} {self.register_type}[{addr}] -> 0x{exception_code:02X}")
                # Return empty list to trigger exception in pymodbus
                return []
        
        # Simulate response delay if configured for this slave
        if self.unit_id in SLAVE_DELAYS:
            delay_config = SLAVE_DELAYS[self.unit_id]
            base_delay_ms = delay_config.get("delay_ms", 0)
            jitter_ms = delay_config.get("jitter_ms", 0)
            
            if base_delay_ms > 0 or jitter_ms > 0:
                # Calculate total delay with random jitter
                total_delay_ms = base_delay_ms
                if jitter_ms > 0:
                    total_delay_ms += random.uniform(-jitter_ms, jitter_ms)
                
                # Ensure non-negative
                total_delay_ms = max(0, total_delay_ms)
                
                if total_delay_ms > 0:
                    logger.debug(f"Slave {self.unit_id} response delay: {total_delay_ms:.1f}ms")
                    time.sleep(total_delay_ms / 1000.0)  # Convert to seconds
        
        # Log register access for statistics
        for i in range(count):
            addr = address + i
            log_key = (self.unit_id, self.register_type, addr)
            if log_key not in REGISTER_ACCESS_LOG:
                REGISTER_ACCESS_LOG[log_key] = {"reads": 0, "writes": 0}
            
            REGISTER_ACCESS_LOG[log_key]["reads"] += 1
            REGISTER_ACCESS_LOG[log_key]["last_read"] = time.time()
        
        # Get current profile for logging
        active_profile = get_active_profile()
        
        # Log the request (summary only at INFO)
        logger.info(f"📤 SENDING DATA - Poll: profile={active_profile}, slave={self.unit_id}, type={self.register_type}, addr={address}, count={count}")

        values = []
        data_points_details = []  # Collect details for summary log
        
        for i in range(count):
            addr = address + i
            idx = addr - self.address
            
            # Return stored value
            if 0 <= idx < len(self.values):
                val = self.values[idx]
                values.append(val)
                
                # DEBUG: Log problematic addresses
                if addr in [99, 129, 139, 149, 159] and self.unit_id == 1 and self.register_type == 'holding':
                    logger.info(f"[DEBUG] getValues() reading addr={addr} idx={idx} value={val} (self.address={self.address})")
                
                # Log with data point name if available (O(1) lookup)
                key = (self.register_type, addr)
                dp = self._dp_index.get(key)
                if dp:
                    dp_name = dp.get("name", "unknown")
                    
                    # Check for GUI overrides (only for writable types)
                    if self.register_type in ['holding', 'coil'] and addr in REGISTER_OVERRIDES:
                        logger.info(f"  → 📊 {addr}: {val} (GUI override: {active_profile}.{dp_name})")
                        data_points_details.append(f"{dp_name}={val}")
                    else:
                        # Define register type semantics
                        type_desc = {
                            'holding': 'R/W',
                            'input': 'R/O sensor',
                            'coil': 'W output',
                            'discrete': 'R/O status'
                        }.get(self.register_type, 'unknown')
                        
                        base = dp.get("base", 100) if self.register_type in ['holding', 'input'] else None
                        if base:
                            logger.info(f"  → 📊 {addr}: {val} ({active_profile}.{dp_name}, base={base}, {type_desc})")
                        else:
                            logger.info(f"  → 📊 {addr}: {val} ({active_profile}.{dp_name}, {type_desc})")
                        data_points_details.append(f"{dp_name}={val}")
                else:
                    if val != 0 and self.register_type in ['holding', 'input']:
                        logger.info(f"  → 📊 {addr}: {val} (DEFAULT - no {self.register_type} config)")
                        data_points_details.append(f"addr_{addr}={val}")
                    elif logger.isEnabledFor(logging.DEBUG):
                        logger.debug(f"  → {addr}: {val} (DEFAULT)")
                        if val != 0:
                            data_points_details.append(f"addr_{addr}={val}")
            else:
                # Address out of range
                val = False if self.register_type in ['coil', 'discrete'] else 0
                values.append(val)
                logger.warning(f"  → ⚠️ {addr}: {val} (OUT OF RANGE)")

        # Summary log with all values
        logger.info(f"✅ RESPONSE SENT: {len(values)} values - {data_points_details if data_points_details else values}")
        logger.debug(f"Raw values returned: {values}")
        return values
    
    def setValues(self, address, values):
        """Handle Modbus write commands (for holding registers and coils)"""
        # CRITICAL FIX: pymodbus server adds +1 to incoming addresses (Modbus 1-based protocol)
        # Client sends write to 99 → server calls setValues(100)
        # We need 0-based addressing, so subtract 1
        address = address - 1
        
        active_profile = get_active_profile()
        
        # Log write command
        writable = self.register_type in ['holding', 'coil']
        if not writable:
            logger.warning(f"Write attempt to read-only {self.register_type} registers: addr={address}, values={values}")
            return  # Silently ignore (pymodbus should block this anyway)
        
        # Check if slave is disabled (simulates device offline/failure)
        if self.unit_id in DISABLED_SLAVES:
            logger.warning(f"Slave {self.unit_id} is disabled - rejecting write request for {self.register_type}[{address}:{address+len(values)-1}]")
            return  # Skip write to trigger Modbus exception
        
        # Check for register-specific exception injection
        for i in range(len(values)):
            addr = address + i
            exception_key = (self.unit_id, self.register_type, addr)
            if exception_key in EXCEPTION_INJECTIONS:
                exception_code = EXCEPTION_INJECTIONS[exception_key]
                logger.warning(f"Exception injection on write: slave {self.unit_id} {self.register_type}[{addr}] -> 0x{exception_code:02X}")
                return  # Skip write to trigger exception
        
        # Log register access for statistics
        for i in range(len(values)):
            addr = address + i
            log_key = (self.unit_id, self.register_type, addr)
            if log_key not in REGISTER_ACCESS_LOG:
                REGISTER_ACCESS_LOG[log_key] = {"reads": 0, "writes": 0}
            
            REGISTER_ACCESS_LOG[log_key]["writes"] += 1
            REGISTER_ACCESS_LOG[log_key]["last_write"] = time.time()
        
        logger.info(f"📥 RECEIVING WRITE - profile={active_profile}, type={self.register_type}, addr={address}, values={values}")
        
        # Apply writes to storage
        changes = []
        for i, value in enumerate(values):
            addr = address + i
            idx = addr - self.address
            
            if 0 <= idx < len(self.values):
                old_val = self.values[idx]
                
                # Lookup data point for logging (O(1))
                key = (self.register_type, addr)
                dp = self._dp_index.get(key)
                dp_name = dp.get("name", "unknown") if dp else "unconfigured"
                
                # Store new value
                super().setValues(addr, [value])
                
                # Log the change with context
                if self.register_type == 'coil':
                    logger.info(f"  → 💾 Coil {addr} ({dp_name}): {old_val} → {value}")
                    changes.append(f"{dp_name}: {old_val}→{value}")
                else:
                    logger.info(f"  → 💾 Register {addr} ({dp_name}): {old_val} → {value}")
                    logger.debug(f"     Control action applied to {active_profile}.{dp_name}")
                    changes.append(f"{dp_name}: {old_val}→{value}")
            else:
                logger.warning(f"  → ⚠️ Write to out-of-range address {addr} (ignored)")
        
        # Summary log
        if changes:
            logger.info(f"✅ WRITE COMPLETE: {len(changes)} changes - {changes}")

def setup_server(slaves=3):
    """Setup Modbus TCP server simulating profile devices"""
    slave_contexts = {}
    identities = {}

    for unit_id in range(1, slaves + 1):
        # Holding Registers (HR): Read/write registers for configuration, setpoints
        # 0-based addressing to match Modbus protocol (agent sends 0-based addresses)
        hr = ProfileDataBlock(0, [0]*200, register_type='holding', unit_id=unit_id)
        
        # Input Registers (IR): Read-only registers for sensor readings, status
        # 0-based addressing to match Modbus protocol
        ir = ProfileDataBlock(0, [0]*100, register_type='input', unit_id=unit_id)
        
        # Coils (CO): Writable binary outputs (alarms, control signals)
        # 0-based addressing to match Modbus protocol
        co = ProfileDataBlock(0, [False]*20, register_type='coil', unit_id=unit_id)
        
        # Discrete Inputs (DI): Read-only binary status (sensor triggers, faults)
        # 0-based addressing to match Modbus protocol
        di = ProfileDataBlock(0, [False]*20, register_type='discrete', unit_id=unit_id)

        # Use DisableableSlaveContext to support slave failure simulation
        # zero=True means addresses are 0-based (not 1-based Modbus protocol convention)
        store = DisableableSlaveContext(unit_id=unit_id, hr=hr, ir=ir, co=co, di=di, zero=True)
        slave_contexts[unit_id] = store

        identity = ModbusDeviceIdentification()
        identity.VendorName = PROFILE
        identity.ProductCode = f"{PROFILE}-{unit_id}"
        identity.VendorUrl = profile_data.get(PROFILE, {}).get("vendorUrl", "")
        identity.ProductName = f"{PROFILE} Modbus Simulator"
        identity.ModelName = profile_data.get(PROFILE, {}).get("model", "Generic Controller")
        identity.MajorMinorRevision = profile_data.get(PROFILE, {}).get("version", "1.0.0")
        identities[unit_id] = identity

    context = ModbusServerContext(slaves=slave_contexts, single=False)
    return context, identities

def main():
    slaves_to_simulate = int(os.environ.get("MODBUS_SLAVES", 3))
    tcp_port = int(os.environ.get("MODBUS_PORT", 502))
    tcp_host = os.environ.get("MODBUS_HOST", "0.0.0.0")
    
    # MODBUS TCP LIMITATION: All slave units share the same device identity
    # Unlike Modbus RTU, Modbus TCP does not support per-slave identities.
    # This means all slaves (unit IDs 1, 2, 3...) appear as the same profile/model.
    #
    # WORKAROUND FOR MULTI-PROFILE TESTING:
    # Run separate simulator instances on different ports:
    #   docker run -e MODBUS_PROFILE=COMAP -e MODBUS_PORT=502 modbus-simulator
    #   docker run -e MODBUS_PROFILE=ComAp-InteliGen -e MODBUS_PORT=503 modbus-simulator
    #
    # This provides realistic multi-profile simulation for edge device testing.
    logger.info(f"Starting Modbus TCP Simulator for profile '{PROFILE}' with {slaves_to_simulate} slaves on {tcp_host}:{tcp_port}")
    if slaves_to_simulate > 1:
        logger.warning(f"⚠️  All {slaves_to_simulate} slaves will share profile identity '{PROFILE}' (Modbus TCP limitation)")
        logger.warning(f"⚠️  For multi-profile testing, run separate simulator instances on different ports")

    context, identities = setup_server(slaves=slaves_to_simulate)

    try:
        StartTcpServer(
            context=context,
            identity=identities[1],  # Modbus TCP: shared identity for all slaves
            address=(tcp_host, tcp_port)
        )
    except KeyboardInterrupt:
        logger.info(f"Shutting down Modbus TCP Simulator for profile '{PROFILE}'")

if __name__ == "__main__":
    main()
