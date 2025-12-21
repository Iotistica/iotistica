#!/usr/bin/env python3
"""
Generic Modbus TCP Simulator
Supports multiple slave IDs with vendor-specific data points loaded from API or JSON.
Environment Variables:
- MODBUS_VENDOR: name of the vendor to simulate (default: 'Generic')
- MODBUS_API_URL: API URL to fetch vendor data (default: 'http://api:3002')
- MODBUS_VENDOR_JSON: fallback path to JSON file (default: './vendors/dataPoints.json')
- MODBUS_SLAVES: number of slave IDs to simulate (default: 3)
- MODBUS_PORT: TCP port to listen on (default: 502)
"""
import logging
import time
import random
import os
import json
import urllib.request
from pymodbus.server import StartTcpServer
from pymodbus.device import ModbusDeviceIdentification
from pymodbus.datastore import ModbusSequentialDataBlock, ModbusSlaveContext, ModbusServerContext

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Configuration
VENDOR = os.environ.get("MODBUS_VENDOR", "Generic")
API_URL = os.environ.get("MODBUS_API_URL", "http://api:3002")
JSON_FILE = os.environ.get("MODBUS_VENDOR_JSON", "./vendors/dataPoints.json")

# Load vendor data from API or fallback to file
def load_vendor_data():
    """Load vendor data points from API, fallback to local file"""
    # Try API first (with retries)
    max_retries = 3
    retry_delay = 2  # seconds
    
    for attempt in range(max_retries):
        try:
            url = f"{API_URL}/api/v1/vendors/datapoints?protocol=modbus"
            logger.info(f"Fetching vendor data from API: {url} (attempt {attempt + 1}/{max_retries})")
            
            req = urllib.request.Request(url, headers={'User-Agent': 'modbus-simulator/1.0'})
            with urllib.request.urlopen(req, timeout=5) as response:
                vendor_data = json.loads(response.read().decode())
                logger.info(f"✓ Loaded vendor data from API ({len(vendor_data)} vendors)")
                return vendor_data
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
            vendor_data = json.load(f)
            logger.info(f"✓ Loaded vendor data from file ({len(vendor_data)} vendors)")
            return vendor_data
    except Exception as e:
        logger.error(f"Failed to load vendor data from file '{JSON_FILE}': {e}")
        return {}

vendor_data = load_vendor_data()

# State file for inter-process communication
STATE_FILE = "/tmp/modbus_simulator_state.json"

def get_active_vendor():
    """Read active vendor from state file (shared with GUI)"""
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r") as f:
                state = json.load(f)
                return state.get("vendor", VENDOR)
    except Exception as e:
        logger.warning(f"Failed to read state file: {e}")
    return VENDOR

def get_data_points():
    """Get data points for active vendor"""
    active_vendor = get_active_vendor()
    return vendor_data.get(active_vendor, {}).get("dataPoints", [])

# Shared state for GUI overrides (imported by web_gui.py)
try:
    from web_gui import REGISTER_OVERRIDES
    logger.info("GUI integration enabled - using shared REGISTER_OVERRIDES")
except ImportError:
    REGISTER_OVERRIDES = {}
    logger.info("GUI not available - running in standalone mode")

class VendorDataBlock(ModbusSequentialDataBlock):
    """Simulate Modbus registers for any vendor with stateful updates"""
    def __init__(self, address, values, is_coil=False, register_type='holding'):
        super().__init__(address, values)
        self.start_time = time.time()
        self.is_coil = is_coil
        self.register_type = register_type  # 'holding', 'input', 'coil', 'discrete'
        self.last_update = time.time()
        self.update_interval = 1.0  # Update stored values every 1 second
        
        # Initialize registers with realistic values
        self._initialize_registers()
    
    def _initialize_registers(self):
        """Initialize register values based on vendor data points"""
        current_data_points = get_data_points()
        
        for dp in current_data_points:
            addr = dp.get("address")
            dp_type = dp.get("type", "holding")
            
            # Skip if address is out of range for this block
            if addr < self.address or addr >= self.address + len(self.values):
                continue
            
            # Skip if data point type doesn't match this block's register type
            if self.is_coil and dp_type not in ["coil", "discrete"]:
                continue
            if not self.is_coil and dp_type not in ["holding", "input"]:
                continue
            if self.register_type != dp_type:
                continue
            
            idx = addr - self.address
            
            if self.is_coil:
                # Initialize coils/discrete inputs as False (no alarms)
                self.values[idx] = False
            else:
                # Initialize holding/input registers with base value
                base = dp.get("base", 100)
                noise_pct = dp.get("noise_pct", 0.05)
                self.values[idx] = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
    
    def _update_registers(self):
        """Update register values with realistic drift (called periodically)"""
        current_data_points = get_data_points()
        active_vendor = get_active_vendor()
        
        for dp in current_data_points:
            addr = dp.get("address")
            dp_type = dp.get("type", "holding")
            
            # Skip if address is out of range
            if addr < self.address or addr >= self.address + len(self.values):
                continue
            
            # Skip if data point type doesn't match this block's register type
            if self.is_coil and dp_type not in ["coil", "discrete"]:
                continue
            if not self.is_coil and dp_type not in ["holding", "input"]:
                continue
            if self.register_type != dp_type:
                continue
            
            idx = addr - self.address
            
            if self.is_coil:
                # Alarms: 5% chance to trigger
                self.values[idx] = bool(random.random() < 0.05)
            else:
                # Check for GUI override first (only for holding registers)
                if self.register_type == 'holding' and addr in REGISTER_OVERRIDES:
                    override = REGISTER_OVERRIDES[addr]
                    base = override.get("base", 100)
                    noise_pct = override.get("noise_pct", 0.05)
                    self.values[idx] = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
                else:
                    # Use vendor config (for both holding and input registers)
                    # Input registers simulate sensor readings that change over time
                    base = dp.get("base", 100)
                    noise_pct = dp.get("noise_pct", 0.05)
                    self.values[idx] = int(base * (1 + random.uniform(-noise_pct, noise_pct)))

    def getValues(self, address, count=1):
        """Read stored register values (stateful, no mutation on read)"""
        # Update registers if enough time has passed
        current_time = time.time()
        if current_time - self.last_update >= self.update_interval:
            self._update_registers()
            self.last_update = current_time
        
        # Get current vendor for logging
        active_vendor = get_active_vendor()
        current_data_points = get_data_points()
        
        # Log the request
        logger.info(f"Agent polling: vendor={active_vendor}, type={self.register_type}, addr={address}, count={count}")

        values = []
        for i in range(count):
            addr = address + i
            idx = addr - self.address
            
            # Return stored value
            if 0 <= idx < len(self.values):
                val = self.values[idx]
                values.append(val)
                
                # Log with data point name if available
                dp = next((dp for dp in current_data_points if dp["address"] == addr and dp.get("type") == self.register_type), None)
                if dp:
                    dp_name = dp.get("name", "unknown")
                    if self.register_type == 'holding' and addr in REGISTER_OVERRIDES:
                        logger.info(f"  → addr {addr}: {val} (source: GUI override for {active_vendor}.{dp_name})")
                    else:
                        base = dp.get("base", 100)
                        source_type = "read-only sensor" if self.register_type == 'input' else "read/write register"
                        logger.info(f"  → addr {addr}: {val} (source: {active_vendor}.{dp_name}, base={base}, type={source_type})")
                else:
                    if val != 0 and not self.is_coil:
                        logger.warning(f"  → addr {addr}: {val} (source: DEFAULT - no {self.register_type} config for address {addr} in {active_vendor})")
                    else:
                        logger.info(f"  → addr {addr}: {val} (source: DEFAULT)")
            else:
                # Address out of range
                val = False if self.is_coil else 0
                values.append(val)
                logger.warning(f"  → addr {addr}: {val} (source: OUT OF RANGE)")

        logger.info(f"Returned {len(values)} values: {values}")
        return values

def setup_server(slaves=3):
    """Setup Modbus TCP server simulating vendor devices"""
    slave_contexts = {}
    identities = {}

    for unit_id in range(1, slaves + 1):
        # Holding Registers (HR): Read/write registers for configuration, setpoints
        hr = VendorDataBlock(1, [0]*200, register_type='holding')
        
        # Input Registers (IR): Read-only registers for sensor readings, status
        ir = VendorDataBlock(1, [0]*100, register_type='input')
        
        # Coils (CO): Read/write boolean outputs
        co = VendorDataBlock(1, [False]*20, is_coil=True, register_type='coil')
        
        # Discrete Inputs (DI): Read-only boolean inputs
        di = VendorDataBlock(1, [False]*20, is_coil=True, register_type='discrete')

        store = ModbusSlaveContext(hr=hr, ir=ir, co=co, di=di)
        slave_contexts[unit_id] = store

        identity = ModbusDeviceIdentification()
        identity.VendorName = VENDOR
        identity.ProductCode = f"{VENDOR}-{unit_id}"
        identity.VendorUrl = vendor_data.get(VENDOR, {}).get("vendorUrl", "")
        identity.ProductName = f"{VENDOR} Modbus Simulator"
        identity.ModelName = vendor_data.get(VENDOR, {}).get("model", "Generic Controller")
        identity.MajorMinorRevision = vendor_data.get(VENDOR, {}).get("version", "1.0.0")
        identities[unit_id] = identity

    context = ModbusServerContext(slaves=slave_contexts, single=False)
    return context, identities

def main():
    slaves_to_simulate = int(os.environ.get("MODBUS_SLAVES", 3))
    tcp_port = int(os.environ.get("MODBUS_PORT", 502))
    tcp_host = os.environ.get("MODBUS_HOST", "0.0.0.0")
    logger.info(f"Starting Modbus TCP Simulator for vendor '{VENDOR}' with {slaves_to_simulate} slaves on {tcp_host}:{tcp_port}")

    context, identities = setup_server(slaves=slaves_to_simulate)

    try:
        StartTcpServer(
            context=context,
            identity=identities[1],  # use first slave's identity
            address=(tcp_host, tcp_port)
        )
    except KeyboardInterrupt:
        logger.info(f"Shutting down Modbus TCP Simulator for vendor '{VENDOR}'")

if __name__ == "__main__":
    main()
