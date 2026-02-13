#!/usr/bin/env python3
"""
Unified Modbus TCP/RTU Simulator with Web GUI
Combines Modbus server and Flask GUI in a single process with shared state.

Architecture:
- Modbus TCP or RTU server runs in background thread
- Flask GUI runs in main thread
- Shared in-memory state (no file IPC)
- Profile hot-swapping via GUI
- Real-time register overrides

Environment Variables:
- TRANSPORT: transport type ('tcp' or 'rtu', default: 'tcp')
- MODBUS_PROFILE: initial profile (default: 'Generic')
- SLAVES: number of slave IDs (default: 3)
- MODBUS_PORT: Modbus TCP port (default: 502) or RTU serial port (e.g., '/dev/ttyUSB0')
- MODBUS_BAUDRATE: RTU baudrate (default: 19200)
- MODBUS_BYTESIZE: RTU bytesize (default: 8)
- MODBUS_PARITY: RTU parity ('N', 'E', 'O', default: 'N')
- MODBUS_STOPBITS: RTU stopbits (default: 1)
- GUI_PORT: Flask web GUI port (default: 5000)
- LOG_LEVEL: logging level (default: INFO)
"""
import os
import sys
import json
import time
import random
import logging
import threading
import urllib.request
import urllib.error
import ssl
from flask import Flask, render_template, jsonify, request
from flask_cors import CORS
from pymodbus.server import StartTcpServer, StartSerialServer
from pymodbus.device import ModbusDeviceIdentification
from pymodbus.datastore import ModbusSequentialDataBlock, ModbusSlaveContext, ModbusServerContext
from pymodbus.exceptions import ModbusException

# Configure logging
log_level = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, log_level, logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Import shared profile loader
from profile_loader import load_profile_data

# =============================================================================
# SHARED STATE (accessed by both Modbus server and Flask GUI)
# =============================================================================
ACTIVE_PROFILE = os.environ.get("PROFILE", "Generic")
profile_data = load_profile_data()
profile_loaded = False  # Track if profile was successfully loaded

# GUI control state (shared memory, no file IPC needed!)
REGISTER_OVERRIDES = {}  # {address: {"base": int, "noise_pct": float, "value": int}}
DISABLED_SLAVES = set()  # Set of disabled slave unit IDs
SLAVE_DELAYS = {}  # {slave_id: {"delay_ms": int, "jitter_ms": int}}
REGISTER_ACCESS_LOG = {}  # {(slave_id, reg_type, address): {reads: int, writes: int, last_read: float, last_write: float}}
EXCEPTION_INJECTIONS = {}  # {(slave_id, reg_type, address): exception_code}
ACTIVE_SCENARIO = None  # Track currently applied scenario

# Profile indexing
PROFILE_INDEX = {}  # {profile_name: {(type, address): datapoint}}

# Validate initial profile
if ACTIVE_PROFILE not in profile_data:
    available = list(profile_data.keys())
    logger.error(f"❌ Profile '{ACTIVE_PROFILE}' not found. Available: {available}")
    if available:
        ACTIVE_PROFILE = available[0]
        logger.warning(f"Defaulting to '{ACTIVE_PROFILE}'")
        profile_loaded = True
    else:
        logger.warning(f"No profiles loaded yet, will retry in background")
else:
    logger.info(f"✓ Loaded profile '{ACTIVE_PROFILE}'")
    profile_loaded = True

# =============================================================================
# SHARED FUNCTIONS
# =============================================================================
def get_active_profile():
    """Get current active profile (thread-safe read)"""
    return ACTIVE_PROFILE

def set_active_profile(profile_name):
    """Set active profile (called by GUI)"""
    global ACTIVE_PROFILE
    if profile_name in profile_data:
        ACTIVE_PROFILE = profile_name
        logger.info(f"Profile switched to: {profile_name}")
        return True
    else:
        logger.error(f"Profile '{profile_name}' not found")
        return False

def build_profile_index(profile_name: str) -> dict:
    """Build O(1) lookup index for profile data points"""
    profile_obj = profile_data.get(profile_name, {})
    data_points = profile_obj.get("dataPoints", [])
    logger.debug(f"Indexing {len(data_points)} data points for '{profile_name}'")
    
    index = {}
    for dp in data_points:
        addr = dp.get("address")
        dp_type = dp.get("type", "holding")
        if addr is not None:
            key = (dp_type, addr)
            index[key] = dp
    return index

# Preload indexes for all profiles
for profile in profile_data.keys():
    PROFILE_INDEX[profile] = build_profile_index(profile)
logger.info(f"Preloaded {len(PROFILE_INDEX)} profile indexes")

# =============================================================================
# PROFILE AUTO-RELOAD (for K8s environments where API may not be ready at startup)
# =============================================================================
def retry_profile_loading():
    """Background thread to retry loading profiles if initial load failed"""
    global profile_data, ACTIVE_PROFILE, PROFILE_INDEX, profile_loaded
    
    retry_interval = 10  # seconds
    max_retries = 12  # 2 minutes total
    
    for attempt in range(max_retries):
        if profile_loaded:
            logger.info("Profile already loaded, stopping retry thread")
            return
        
        time.sleep(retry_interval)
        logger.info(f"Retrying profile load (attempt {attempt + 1}/{max_retries})...")
        
        try:
            new_profile_data = load_profile_data()
            if new_profile_data:
                profile_data.update(new_profile_data)
                
                # Set active profile
                desired_profile = os.environ.get("PROFILE", "Generic")
                if desired_profile in profile_data:
                    ACTIVE_PROFILE = desired_profile
                elif profile_data:
                    ACTIVE_PROFILE = list(profile_data.keys())[0]
                    logger.warning(f"Desired profile '{desired_profile}' not found, using '{ACTIVE_PROFILE}'")
                
                # Rebuild indexes
                for profile in profile_data.keys():
                    PROFILE_INDEX[profile] = build_profile_index(profile)
                
                profile_loaded = True
                logger.info(f"✓ Profile '{ACTIVE_PROFILE}' loaded successfully on retry")
                return
        except Exception as e:
            logger.warning(f"Profile reload attempt {attempt + 1} failed: {e}")
    
    logger.error(f"Failed to load profiles after {max_retries} retries")

# =============================================================================
# MODBUS SERVER COMPONENTS
# =============================================================================
class DisableableSlaveContext(ModbusSlaveContext):
    """Slave context that respects DISABLED_SLAVES set"""
    def __init__(self, unit_id, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.unit_id = unit_id
    
    def validate(self, fx, address, count=1):
        """Override validation to reject if slave disabled"""
        if self.unit_id in DISABLED_SLAVES:
            logger.debug(f"Slave {self.unit_id} disabled - rejecting request")
            return False
        return super().validate(fx, address, count)

class ProfileDataBlock(ModbusSequentialDataBlock):
    """Dynamic register block with profile-based simulation"""
    def __init__(self, address, values, register_type='holding', unit_id=1):
        super().__init__(address, values)
        self.register_type = register_type
        self.unit_id = unit_id
        self.update_interval = 1.0
        self.last_profile = None
        self._stop_simulation = threading.Event()
        self._dp_index = {}
        
        self._rebuild_index()
        self._initialize_registers()
        
        # Start simulation thread
        self._sim_thread = threading.Thread(target=self._simulation_loop, daemon=True)
        self._sim_thread.start()
    
    def _rebuild_index(self):
        """Use global profile index"""
        active_profile = get_active_profile()
        if active_profile not in PROFILE_INDEX:
            PROFILE_INDEX[active_profile] = build_profile_index(active_profile)
        self._dp_index = PROFILE_INDEX[active_profile]
    
    def _initialize_registers(self):
        """Set initial register values"""
        for addr in range(self.address, self.address + len(self.values)):
            key = (self.register_type, addr)
            dp = self._dp_index.get(key)
            if not dp:
                continue
            
            idx = addr - self.address
            if self.register_type in ['coil', 'discrete']:
                self.values[idx] = False
            else:
                base = dp.get("base", 100)
                noise_pct = dp.get("noise_pct", 0.05)
                self.values[idx] = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
    
    def _simulation_loop(self):
        """Background thread: update register values"""
        while not self._stop_simulation.is_set():
            try:
                self._update_registers()
                self._stop_simulation.wait(timeout=self.update_interval)
            except Exception as e:
                logger.error(f"Simulation error: {e}", exc_info=True)
                time.sleep(self.update_interval)
    
    def _update_registers(self):
        """Update register values with realistic drift"""
        active_profile = get_active_profile()
        
        # Hot-swap profile support
        if active_profile != self.last_profile:
            if self.last_profile is not None:
                logger.info(f"Profile switch: {self.last_profile} → {active_profile}")
            if active_profile not in PROFILE_INDEX:
                PROFILE_INDEX[active_profile] = build_profile_index(active_profile)
            self._dp_index = PROFILE_INDEX[active_profile]
            self.last_profile = active_profile
        
        for addr in range(self.address, self.address + len(self.values)):
            key = (self.register_type, addr)
            dp = self._dp_index.get(key)
            if not dp:
                continue
            
            idx = addr - self.address
            
            if self.register_type == 'discrete':
                self.values[idx] = bool(random.random() < 0.05)
            elif self.register_type == 'coil':
                if addr in REGISTER_OVERRIDES:
                    self.values[idx] = bool(REGISTER_OVERRIDES[addr].get('value', False))
                else:
                    self.values[idx] = bool(random.random() < 0.05)
            elif self.register_type == 'holding':
                if addr in REGISTER_OVERRIDES:
                    override = REGISTER_OVERRIDES[addr]
                    base = override.get("base", 100)
                    noise_pct = override.get("noise_pct", 0.05)
                    self.values[idx] = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
                else:
                    base = dp.get("base", 100)
                    noise_pct = dp.get("noise_pct", 0.05)
                    self.values[idx] = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
            elif self.register_type == 'input':
                base = dp.get("base", 100)
                noise_pct = dp.get("noise_pct", 0.05)
                self.values[idx] = int(base * (1 + random.uniform(-noise_pct, noise_pct)))
    
    def getValues(self, address, count=1):
        """Read register values (with logging and simulation features)"""
        address = address - 1  # Adjust for pymodbus +1 behavior
        
        if self.unit_id in DISABLED_SLAVES:
            logger.warning(f"Slave {self.unit_id} disabled - rejecting read")
            raise ModbusException(0x02)  # Illegal Address
        
        # Check for slave-wide exception injection
        slave_wide_key = (self.unit_id, 'slave_wide', None)
        if slave_wide_key in EXCEPTION_INJECTIONS:
            exception_code = EXCEPTION_INJECTIONS[slave_wide_key]
            logger.warning(f"⚠️ Exception injection: Slave {self.unit_id} returning {exception_code}")
            
            # Map exception codes to Modbus exception codes
            exception_code_map = {
                'illegal_function': 0x01,
                'illegal_address': 0x02,
                'illegal_value': 0x03,
                'slave_failure': 0x04,
                'acknowledge': 0x05,
                'slave_busy': 0x06
            }
            
            code = exception_code_map.get(exception_code, 0x04)
            raise ModbusException(code)
        
        # Check exception injections for specific addresses
        for i in range(count):
            addr = address + i
            exception_key = (self.unit_id, self.register_type, addr)
            if exception_key in EXCEPTION_INJECTIONS:
                logger.warning(f"Exception injection at {exception_key}")
                raise ModbusException(0x02)  # Illegal Address
        
        # Simulate response delay
        if self.unit_id in SLAVE_DELAYS:
            delay_config = SLAVE_DELAYS[self.unit_id]
            delay_ms = delay_config.get("delay_ms", 0)
            jitter_ms = delay_config.get("jitter_ms", 0)
            total_delay = max(0, delay_ms + random.uniform(-jitter_ms, jitter_ms))
            if total_delay > 0:
                time.sleep(total_delay / 1000.0)
        
        # Log access statistics
        for i in range(count):
            addr = address + i
            log_key = (self.unit_id, self.register_type, addr)
            if log_key not in REGISTER_ACCESS_LOG:
                REGISTER_ACCESS_LOG[log_key] = {"reads": 0, "writes": 0}
            REGISTER_ACCESS_LOG[log_key]["reads"] += 1
            REGISTER_ACCESS_LOG[log_key]["last_read"] = time.time()
        
        active_profile = get_active_profile()
        logger.info(f"📤 Read: profile={active_profile}, slave={self.unit_id}, type={self.register_type}, addr={address}, count={count}")
        
        values = []
        for i in range(count):
            addr = address + i
            idx = addr - self.address
            
            if 0 <= idx < len(self.values):
                val = self.values[idx]
                values.append(val)
                
                # Log data point name
                key = (self.register_type, addr)
                dp = self._dp_index.get(key)
                if dp:
                    dp_name = dp.get("name", "unknown")
                    override_marker = " [OVERRIDE]" if addr in REGISTER_OVERRIDES else ""
                    logger.info(f"  → {addr}: {val} ({dp_name}){override_marker}")
            else:
                val = False if self.register_type in ['coil', 'discrete'] else 0
                values.append(val)
                logger.warning(f"  → {addr}: {val} (OUT OF RANGE)")
        
        logger.info(f"✅ Sent {len(values)} values")
        return values
    
    def setValues(self, address, values):
        """Write register values"""
        address = address - 1  # Adjust for pymodbus +1
        
        if self.register_type not in ['holding', 'coil']:
            logger.warning(f"Write to read-only {self.register_type} - ignored")
            return
        
        if self.unit_id in DISABLED_SLAVES:
            logger.warning(f"Slave {self.unit_id} disabled - rejecting write")
            return
        
        # Log access statistics
        for i in range(len(values)):
            addr = address + i
            log_key = (self.unit_id, self.register_type, addr)
            if log_key not in REGISTER_ACCESS_LOG:
                REGISTER_ACCESS_LOG[log_key] = {"reads": 0, "writes": 0}
            REGISTER_ACCESS_LOG[log_key]["writes"] += 1
            REGISTER_ACCESS_LOG[log_key]["last_write"] = time.time()
        
        active_profile = get_active_profile()
        logger.info(f"📥 Write: profile={active_profile}, type={self.register_type}, addr={address}, values={values}")
        
        for i, value in enumerate(values):
            addr = address + i
            idx = addr - self.address
            
            if 0 <= idx < len(self.values):
                old_val = self.values[idx]
                super().setValues(addr, [value])
                
                key = (self.register_type, addr)
                dp = self._dp_index.get(key)
                dp_name = dp.get("name", "unknown") if dp else "unconfigured"
                logger.info(f"  → {addr} ({dp_name}): {old_val} → {value}")
        
        logger.info(f"✅ Write complete")

def setup_modbus_server(slaves=3):
    """Setup Modbus TCP server context"""
    slave_contexts = {}
    
    for unit_id in range(1, slaves + 1):
        hr = ProfileDataBlock(0, [0]*200, register_type='holding', unit_id=unit_id)
        ir = ProfileDataBlock(0, [0]*100, register_type='input', unit_id=unit_id)
        co = ProfileDataBlock(0, [False]*20, register_type='coil', unit_id=unit_id)
        di = ProfileDataBlock(0, [False]*20, register_type='discrete', unit_id=unit_id)
        
        store = DisableableSlaveContext(unit_id=unit_id, hr=hr, ir=ir, co=co, di=di, zero=True)
        slave_contexts[unit_id] = store
    
    context = ModbusServerContext(slaves=slave_contexts, single=False)
    return context

def run_modbus_server():
    """Run Modbus TCP or RTU server (blocking call)"""
    transport = os.environ.get("TRANSPORT", "tcp").lower()
    slaves = int(os.environ.get("SLAVES", 3))
    
    logger.info(f"Starting Modbus {transport.upper()} server ({slaves} slaves)")
    context = setup_modbus_server(slaves=slaves)
    
    try:
        if transport == "rtu":
            # Modbus RTU over serial
            port = os.environ.get("PORT", "/dev/ttyUSB0")
            baudrate = int(os.environ.get("MODBUS_BAUDRATE", 19200))
            bytesize = int(os.environ.get("MODBUS_BYTESIZE", 8))
            parity = os.environ.get("MODBUS_PARITY", "N")
            stopbits = int(os.environ.get("MODBUS_STOPBITS", 1))
            
            logger.info(f"RTU config: port={port}, baudrate={baudrate}, bytesize={bytesize}, parity={parity}, stopbits={stopbits}")
            
            StartSerialServer(
                context=context,
                port=port,
                baudrate=baudrate,
                bytesize=bytesize,
                parity=parity,
                stopbits=stopbits,
                timeout=1
            )
        else:
            # Modbus TCP (default)
            port = int(os.environ.get("PORT", 502))
            host = os.environ.get("MODBUS_HOST", "0.0.0.0")
            
            logger.info(f"TCP config: {host}:{port}")
            StartTcpServer(context=context, address=(host, port))
    except Exception as e:
        logger.error(f"Modbus server error: {e}", exc_info=True)

# =============================================================================
# FLASK WEB GUI COMPONENTS
# =============================================================================
app = Flask(__name__)
CORS(app)

# Modbus exception codes
EXCEPTION_CODES = {
    "illegal_function": 0x01,
    "illegal_address": 0x02,
    "illegal_value": 0x03,
    "slave_failure": 0x04,
    "acknowledge": 0x05,
    "slave_busy": 0x06
}

# Scenario definitions (using register names, profile-agnostic)
SCENARIO_DEFINITIONS = {
    # COMAP Generator scenarios
    "comap_normal_operation": {
        "default": False,
        "profiles": ["COMAP", "COMAP-InteliGen"],
        "engine_rpm": {"base": 1500, "noise_pct": 0.02},
        "power_kw": {"base": 100, "noise_pct": 0.05},
        "gen_voltage_c": {"base": 230, "noise_pct": 0.02},  # Reduced from 0.25 to match datapoints config
    },
    "comap_overvoltage": {
        "default": False,
        "profiles": ["COMAP", "COMAP-InteliGen"],
        "gen_voltage_c": {"base": 260, "noise_pct": 0.01},
        "power_kw": {"base": 120, "noise_pct": 0.05},
    },
    "comap_low_oil_pressure": {
        "default": False,
        "profiles": ["COMAP", "COMAP-InteliGen"],
        "oil_pressure": {"base": 15, "noise_pct": 0.05},
        "engine_rpm": {"base": 1450, "noise_pct": 0.03},
    },
    
    # PM556x Power Meter scenarios
    "pm556x_normal_load": {
        "default": False,
        "profiles": ["PM556x"],
        "Current L1": {"base": 10, "noise_pct": 0.05},
        "Current L2": {"base": 10, "noise_pct": 0.05},
        "Current L3": {"base": 10, "noise_pct": 0.05},
        "Voltage L1-N": {"base": 230, "noise_pct": 0.01},
        "Voltage L2-N": {"base": 230, "noise_pct": 0.01},
        "Voltage L3-N": {"base": 230, "noise_pct": 0.01},
    },
    "pm556x_high_load": {
        "default": False,
        "profiles": ["PM556x"],
        "Current L1": {"base": 50, "noise_pct": 0.10},
        "Current L2": {"base": 48, "noise_pct": 0.10},
        "Current L3": {"base": 52, "noise_pct": 0.10},
        "Power L1": {"base": 11500, "noise_pct": 0.08},
    },
}

def resolve_scenario_to_addresses(scenario_name, scenario_def, profile_name):
    """Resolve scenario register names to addresses for a specific profile"""
    if profile_name not in profile_data:
        logger.error(f"Profile '{profile_name}' not found")
        return {}
    
    # Build register name -> address mapping for profile
    name_to_address = {}
    for dp in profile_data[profile_name].get('dataPoints', []):
        name = dp.get('name')
        address = dp.get('address')
        dp_type = dp.get('type', 'holding')
        if name and address is not None and dp_type == 'holding':
            name_to_address[name] = address
    
    # Resolve scenario register names to addresses
    resolved = {}
    for reg_name, override_config in scenario_def.items():
        # Skip metadata fields
        if reg_name in ['default', 'profiles']:
            continue
        
        if reg_name in name_to_address:
            address = name_to_address[reg_name]
            resolved[address] = override_config
        else:
            logger.debug(f"Scenario '{scenario_name}': register '{reg_name}' not found in profile '{profile_name}'")
    
    return resolved

@app.route('/')
def index():
    """Serve GUI homepage"""
    # Reload profile data to pick up any new profiles saved via API
    global profile_data
    profile_data = load_profile_data()
    
    return render_template('index.html', 
                          current_profile=get_active_profile(),
                          profiles=list(profile_data.keys()))

@app.route('/api/profile', methods=['GET'])
def get_profile():
    """Get current active profile"""
    return jsonify({
        'profile': get_active_profile(),
        'available_profiles': list(profile_data.keys())
    })

@app.route('/api/profile', methods=['POST'])
def switch_profile():
    """Switch to different profile"""
    data = request.get_json()
    profile_name = data.get('profile')
    
    if set_active_profile(profile_name):
        # Clear overrides when switching profiles
        global REGISTER_OVERRIDES
        REGISTER_OVERRIDES = {}
        return jsonify({'success': True, 'profile': profile_name})
    else:
        return jsonify({'success': False, 'error': 'Profile not found'}), 404

@app.route('/api/profile/switch/<profile_name>', methods=['POST'])
def switch_profile_by_path(profile_name):
    """Switch to different profile (path-based)"""
    if set_active_profile(profile_name):
        # Don't clear overrides - let the caller manage them
        # This allows Apply button to switch profile AND keep staged overrides
        return jsonify({'success': True, 'profile': profile_name})
    else:
        return jsonify({'success': False, 'error': 'Profile not found'}), 404

@app.route('/api/profiles', methods=['GET'])
def list_profiles():
    """List all available profiles"""
    profiles_list = []
    for name, data in profile_data.items():
        profiles_list.append({
            'name': name,
            'datapoint_count': len(data.get('dataPoints', [])),
            'vendor_url': data.get('vendorUrl', ''),
            'model': data.get('model', '')
        })
    return jsonify(profiles_list)

@app.route('/api/datapoints/<profile_name>', methods=['GET'])
def get_datapoints(profile_name):
    """Get data points for a specific profile"""
    if profile_name not in profile_data:
        return jsonify({'error': 'Profile not found'}), 404
    
    return jsonify({
        'profile': profile_name,
        'dataPoints': profile_data[profile_name].get('dataPoints', [])
    })

@app.route('/api/profile/save', methods=['POST'])
def save_profile():
    """Save current profile with overrides to API"""
    try:
        data = request.get_json()
        new_profile_name = data.get('profile_name')
        source_profile = data.get('source_profile', get_active_profile())
        staged_overrides = data.get('staged_overrides', {})  # Overrides from UI that haven't been applied yet
        
        if not new_profile_name:
            return jsonify({'success': False, 'error': 'profile_name is required'}), 400
        
        # Get source profile data (current active profile or specified)
        if source_profile not in profile_data:
            return jsonify({'success': False, 'error': f'Source profile {source_profile} not found'}), 404
        
        # Get base profile data
        base_profile = profile_data[source_profile]
        data_points = []
        
        # Merge applied overrides and staged overrides for logging
        total_overrides = len(REGISTER_OVERRIDES) + len(staged_overrides)
        logger.info(f"Saving profile '{new_profile_name}' from source '{source_profile}' with {len(REGISTER_OVERRIDES)} applied + {len(staged_overrides)} staged overrides")
        
        # Deep copy data points and apply overrides (both applied and staged)
        for dp in base_profile.get('dataPoints', []):
            dp_copy = dp.copy()
            address = dp_copy.get('address')
            address_str = str(address)
            
            # First apply already-applied overrides from REGISTER_OVERRIDES
            if address in REGISTER_OVERRIDES:
                override = REGISTER_OVERRIDES[address]
                dp_copy['base'] = override.get('base', dp_copy.get('base', 100))
                dp_copy['noise_pct'] = override.get('noise_pct', dp_copy.get('noise_pct', 0.05))
                logger.debug(f"Applied server override for address {address}: base={dp_copy['base']}, noise_pct={dp_copy['noise_pct']}")
            
            # Then apply staged overrides (from UI, not yet applied to server)
            if address_str in staged_overrides:
                override = staged_overrides[address_str]
                dp_copy['base'] = override.get('base', dp_copy.get('base', 100))
                dp_copy['noise_pct'] = override.get('noise_pct', dp_copy.get('noise_pct', 0.05))
                logger.debug(f"Applied staged override for address {address}: base={dp_copy['base']}, noise_pct={dp_copy['noise_pct']}")
            
            data_points.append(dp_copy)
        
        # Save to API
        api_url = os.environ.get("API_URL", "http://api:3002")
        api_token = os.environ.get("API_TOKEN", "")
        
        payload = {
            'profile_name': new_profile_name,
            'protocol': 'modbus',
            'data_points': data_points,
            'metadata': {
                'description': base_profile.get('description', f'Copy of {source_profile}'),
                'vendorUrl': base_profile.get('vendorUrl', ''),
                'model': base_profile.get('model', '')
            }
        }
        
        headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'modbus-simulator/1.0'
        }
        if api_token:
            headers['Authorization'] = f'Bearer {api_token}'
        
        req = urllib.request.Request(
            f"{api_url}/api/v1/profiles",
            data=json.dumps(payload).encode('utf-8'),
            headers=headers,
            method='POST'
        )
        
        # Create SSL context that accepts self-signed certificates
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        with urllib.request.urlopen(req, timeout=10, context=ssl_context) as response:
            result = json.loads(response.read().decode())
            logger.info(f"Profile '{new_profile_name}' saved to API with {len(data_points)} data points (source: {source_profile})")
            return jsonify({
                'success': True, 
                'message': f"Profile '{new_profile_name}' saved successfully", 
                'profile': new_profile_name
            })
            
    except urllib.error.HTTPError as e:
        error_msg = e.read().decode() if e.fp else str(e)
        logger.error(f"Failed to save profile to API: {error_msg}")
        return jsonify({'success': False, 'error': f'API error: {error_msg}'}), 500
    except Exception as e:
        logger.error(f"Failed to save profile: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/scenarios/for-profile/<profile_name>', methods=['GET'])
def get_scenarios_for_profile(profile_name):
    """Get scenarios for a specific profile"""
    if profile_name not in profile_data:
        return jsonify({'error': 'Profile not found'}), 404
    
    # Build set of register names in profile
    profile_registers = set(dp['name'] for dp in profile_data[profile_name].get('dataPoints', []))
    
    # Filter scenarios that have matching registers
    available_scenarios = {}
    default_scenario = None
    
    for scenario_name, scenario_def in SCENARIO_DEFINITIONS.items():
        # Check if scenario is for this profile
        scenario_profiles = scenario_def.get('profiles', [])
        is_universal = not scenario_profiles
        is_for_profile = profile_name in scenario_profiles if scenario_profiles else True
        
        if not is_universal and not is_for_profile:
            continue
        
        # Check which registers from scenario exist in profile (skip metadata)
        matching_registers = [reg for reg in scenario_def.keys() 
                            if reg not in ['default', 'profiles'] and reg in profile_registers]
        
        if matching_registers:
            # Generate description from scenario name
            description = scenario_name.replace('_', ' ').title()
            is_default = scenario_def.get('default', False)
            available_scenarios[scenario_name] = {
                "description": description,
                "registers": matching_registers,
                "default": is_default
            }
            if is_default:
                default_scenario = scenario_name
    
    return jsonify({
        'profile': profile_name,
        'scenarios': available_scenarios,
        'default': default_scenario
    })

@app.route('/api/scenarios', methods=['GET'])
def get_scenarios():
    """Get scenarios for current active profile"""
    active_profile = get_active_profile()
    
    if active_profile not in profile_data:
        return jsonify({'scenarios': {}})
    
    # Build set of register names in current profile
    profile_registers = set(dp['name'] for dp in profile_data[active_profile].get('dataPoints', []))
    
    # Filter scenarios
    available_scenarios = {}
    for scenario_name, scenario_def in SCENARIO_DEFINITIONS.items():
        matching_registers = [reg for reg in scenario_def.keys() 
                            if reg not in ['default', 'profiles'] and reg in profile_registers]
        
        if matching_registers:
            description = scenario_name.replace('_', ' ').title()
            available_scenarios[scenario_name] = {
                "description": description,
                "registers": matching_registers
            }
    
    return jsonify({
        'profile': active_profile,
        'scenarios': available_scenarios
    })

@app.route('/api/scenario/<scenario_name>/resolve', methods=['GET'])
def resolve_scenario(scenario_name):
    """Resolve scenario register names to addresses for a profile"""
    profile_name = request.args.get('profile', get_active_profile())
    
    if scenario_name not in SCENARIO_DEFINITIONS:
        return jsonify({
            'success': False,
            'error': f'Unknown scenario: {scenario_name}',
            'available': list(SCENARIO_DEFINITIONS.keys())
        }), 400
    
    if scenario_name == "normal":
        logger.info(f"Scenario '{scenario_name}' resolved for profile '{profile_name}' (clear overrides)")
        return jsonify({
            'success': True,
            'scenario': scenario_name,
            'overrides': {}
        })
    
    scenario_def = SCENARIO_DEFINITIONS[scenario_name]
    resolved_overrides = resolve_scenario_to_addresses(scenario_name, scenario_def, profile_name)
    
    if not resolved_overrides:
        logger.warning(f"Scenario '{scenario_name}' has no matching registers in profile '{profile_name}'")
        return jsonify({
            'success': False,
            'error': f'Scenario "{scenario_name}" has no matching registers in profile "{profile_name}"'
        }), 400
    
    logger.info(f"Scenario '{scenario_name}' resolved for profile '{profile_name}': {len(resolved_overrides)} registers")
    return jsonify({
        'success': True,
        'scenario': scenario_name,
        'profile': profile_name,
        'overrides': resolved_overrides
    })

@app.route('/api/overrides', methods=['GET'])
def get_overrides():
    """Get current register overrides"""
    return jsonify({
        'overrides': {str(k): v for k, v in REGISTER_OVERRIDES.items()},
        'count': len(REGISTER_OVERRIDES)
    })

@app.route('/api/overrides', methods=['POST'])
def set_override():
    """Set register override"""
    data = request.get_json()
    address = int(data.get('address'))
    base = data.get('base', 100)
    noise_pct = data.get('noise_pct', 0.05)
    
    REGISTER_OVERRIDES[address] = {
        'base': base,
        'noise_pct': noise_pct
    }
    
    logger.info(f"Override set: addr={address}, base={base}, noise={noise_pct}")
    return jsonify({'success': True, 'address': address})

@app.route('/api/overrides', methods=['DELETE'])
def clear_all_overrides():
    """Clear all register overrides"""
    global REGISTER_OVERRIDES, ACTIVE_SCENARIO
    count = len(REGISTER_OVERRIDES)
    REGISTER_OVERRIDES.clear()
    ACTIVE_SCENARIO = None
    logger.info(f"✅ Cleared all overrides ({count} registers)")
    return jsonify({'success': True, 'cleared': count})

@app.route('/api/overrides/<int:address>', methods=['DELETE'])
def delete_override(address):
    """Remove register override"""
    if address in REGISTER_OVERRIDES:
        del REGISTER_OVERRIDES[address]
        logger.info(f"Override removed: addr={address}")
        return jsonify({'success': True})
    return jsonify({'success': False, 'error': 'Override not found'}), 404

@app.route('/api/overrides/<int:address>', methods=['PUT'])
def update_override(address):
    """Update or create register override"""
    global ACTIVE_SCENARIO
    
    data = request.get_json()
    base = data.get('base', 100)
    noise_pct = data.get('noise_pct', 0.05)
    scenario = data.get('scenario')  # Optional scenario context
    
    REGISTER_OVERRIDES[address] = {
        'base': base,
        'noise_pct': noise_pct
    }
    
    # Update active scenario
    if scenario:
        ACTIVE_SCENARIO = scenario
        logger.info(f"Override applied from scenario '{scenario}': addr={address}, base={base}, noise={noise_pct}")
    else:
        logger.info(f"Override set: addr={address}, base={base}, noise={noise_pct}")
    
    return jsonify({'success': True, 'address': address})

@app.route('/api/slaves', methods=['GET'])
def get_slaves():
    """Get slave status"""
    return jsonify({
        'disabled_slaves': list(DISABLED_SLAVES),
        'slave_delays': SLAVE_DELAYS
    })

@app.route('/api/slaves/<int:slave_id>/disable', methods=['POST'])
def disable_slave(slave_id):
    """Disable a slave (simulate device failure)"""
    DISABLED_SLAVES.add(slave_id)
    logger.info(f"Slave {slave_id} disabled")
    return jsonify({'success': True, 'slave_id': slave_id, 'disabled': True})

@app.route('/api/slaves/<int:slave_id>/enable', methods=['POST'])
def enable_slave(slave_id):
    """Re-enable a slave"""
    DISABLED_SLAVES.discard(slave_id)
    logger.info(f"Slave {slave_id} enabled")
    return jsonify({'success': True, 'slave_id': slave_id, 'disabled': False})

@app.route('/api/slave/<int:slave_id>/toggle', methods=['POST'])
def toggle_slave(slave_id):
    """Toggle slave enabled/disabled state"""
    if slave_id in DISABLED_SLAVES:
        DISABLED_SLAVES.discard(slave_id)
        logger.info(f"Slave {slave_id} enabled")
        return jsonify({'success': True, 'slave_id': slave_id, 'disabled': False, 'message': f'Slave {slave_id} enabled'})
    else:
        DISABLED_SLAVES.add(slave_id)
        logger.info(f"Slave {slave_id} disabled")
        return jsonify({'success': True, 'slave_id': slave_id, 'disabled': True, 'message': f'Slave {slave_id} disabled'})

@app.route('/api/slave/<int:slave_id>/delay', methods=['POST'])
@app.route('/api/slaves/<int:slave_id>/delay', methods=['POST'])
def set_slave_delay(slave_id):
    """Set response delay for slave"""
    data = request.get_json()
    delay_ms = data.get('delay_ms', 0)
    jitter_ms = data.get('jitter_ms', 0)
    
    SLAVE_DELAYS[slave_id] = {
        'delay_ms': delay_ms,
        'jitter_ms': jitter_ms
    }
    
    logger.info(f"Slave {slave_id} delay: {delay_ms}ms ± {jitter_ms}ms")
    return jsonify({'success': True, 'slave_id': slave_id})

@app.route('/api/exception/inject', methods=['POST'])
def inject_exception():
    """Inject Modbus exception for slave"""
    data = request.get_json()
    slave_id = data.get('slave_id')
    exception_code = data.get('exception_code')
    
    if not slave_id or not exception_code:
        return jsonify({'success': False, 'error': 'Missing slave_id or exception_code'}), 400
    
    if exception_code not in EXCEPTION_CODES:
        return jsonify({'success': False, 'error': f'Invalid exception code: {exception_code}'}), 400
    
    # Inject exception for all register types on this slave
    # Store as (slave_id, register_type, address): exception_code
    # For slave-wide exceptions, we'll set a marker that applies to all addresses
    EXCEPTION_INJECTIONS[(slave_id, 'slave_wide', None)] = exception_code
    
    logger.warning(f"💉 Injected exception '{exception_code}' for Slave {slave_id}")
    return jsonify({
        'success': True,
        'slave_id': slave_id,
        'exception_code': exception_code,
        'description': f"Slave {slave_id} will now return {exception_code} errors"
    })

@app.route('/api/exception/clear', methods=['POST'])
def clear_exception():
    """Clear exception injection for slave"""
    data = request.get_json()
    slave_id = data.get('slave_id')
    
    if not slave_id:
        return jsonify({'success': False, 'error': 'Missing slave_id'}), 400
    
    # Remove slave-wide exception
    key = (slave_id, 'slave_wide', None)
    if key in EXCEPTION_INJECTIONS:
        del EXCEPTION_INJECTIONS[key]
        logger.info(f"✓ Cleared exception injection for Slave {slave_id}")
    
    return jsonify({'success': True, 'slave_id': slave_id})

@app.route('/api/exceptions', methods=['GET'])
def get_exceptions():
    """Get current exception injections"""
    exceptions = []
    for key, exception_code in EXCEPTION_INJECTIONS.items():
        slave_id, reg_type, address = key
        if reg_type == 'slave_wide':
            exceptions.append({
                'slave_id': slave_id,
                'exception_code': exception_code,
                'scope': 'slave_wide'
            })
    return jsonify({'exceptions': exceptions})

@app.route('/api/exceptions/clear', methods=['POST'])
def clear_all_exceptions():
    """Clear all exception injections"""
    count = len(EXCEPTION_INJECTIONS)
    EXCEPTION_INJECTIONS.clear()
    logger.info(f"✓ Cleared all {count} exception injections")
    return jsonify({'success': True, 'cleared': count})

@app.route('/api/stats', methods=['GET'])
def get_stats():
    """Get access statistics"""
    stats = []
    for key, data in REGISTER_ACCESS_LOG.items():
        slave_id, reg_type, address = key
        stats.append({
            'slave_id': slave_id,
            'register_type': reg_type,
            'address': address,
            'reads': data.get('reads', 0),
            'writes': data.get('writes', 0),
            'last_read': data.get('last_read'),
            'last_write': data.get('last_write')
        })
    return jsonify(stats)

@app.route('/api/access-log', methods=['GET'])
def get_access_log():
    """Get formatted access log with summary and human-readable timestamps"""
    now = time.time()
    
    # Build log entries with human-readable timestamps
    log_entries = []
    total_reads = 0
    total_writes = 0
    
    for key, data in REGISTER_ACCESS_LOG.items():
        slave_id, reg_type, address = key
        reads = data.get('reads', 0)
        writes = data.get('writes', 0)
        last_read = data.get('last_read')
        last_write = data.get('last_write')
        
        total_reads += reads
        total_writes += writes
        
        # Convert timestamps to "X ago" format
        last_read_ago = None
        if last_read:
            seconds_ago = int(now - last_read)
            if seconds_ago < 60:
                last_read_ago = f"{seconds_ago}s ago"
            elif seconds_ago < 3600:
                last_read_ago = f"{seconds_ago // 60}m ago"
            else:
                last_read_ago = f"{seconds_ago // 3600}h ago"
        
        last_write_ago = None
        if last_write:
            seconds_ago = int(now - last_write)
            if seconds_ago < 60:
                last_write_ago = f"{seconds_ago}s ago"
            elif seconds_ago < 3600:
                last_write_ago = f"{seconds_ago // 60}m ago"
            else:
                last_write_ago = f"{seconds_ago // 3600}h ago"
        
        log_entries.append({
            'slave_id': slave_id,
            'register_type': reg_type,
            'address': address,
            'reads': reads,
            'writes': writes,
            'last_read_ago': last_read_ago,
            'last_write_ago': last_write_ago,
            'total': reads + writes
        })
    
    # Sort by total accesses (descending)
    log_entries.sort(key=lambda x: x['total'], reverse=True)
    
    return jsonify({
        'total_registers': len(log_entries),
        'total_reads': total_reads,
        'total_writes': total_writes,
        'log': log_entries
    })

@app.route('/api/access-log/export/<format>', methods=['GET'])
def export_access_log(format):
    """Export access log as JSON or CSV"""
    import io
    import csv
    from flask import make_response
    
    if format == 'json':
        response = make_response(jsonify(list(REGISTER_ACCESS_LOG.items())))
        response.headers['Content-Disposition'] = 'attachment; filename=access-log.json'
        response.headers['Content-Type'] = 'application/json'
        return response
    
    elif format == 'csv':
        # Create CSV in memory
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(['Slave ID', 'Register Type', 'Address', 'Reads', 'Writes', 'Last Read', 'Last Write'])
        
        for key, data in REGISTER_ACCESS_LOG.items():
            slave_id, reg_type, address = key
            writer.writerow([
                slave_id,
                reg_type,
                address,
                data.get('reads', 0),
                data.get('writes', 0),
                data.get('last_read', ''),
                data.get('last_write', '')
            ])
        
        response = make_response(output.getvalue())
        response.headers['Content-Disposition'] = 'attachment; filename=access-log.csv'
        response.headers['Content-Type'] = 'text/csv'
        return response
    
    else:
        return jsonify({'error': 'Invalid format. Use json or csv'}), 400

@app.route('/api/access-log/clear', methods=['POST'])
def clear_access_log():
    """Clear all access log data"""
    count = len(REGISTER_ACCESS_LOG)
    REGISTER_ACCESS_LOG.clear()
    logger.info(f"✓ Cleared access log ({count} entries)")
    return jsonify({'success': True, 'cleared': count})

@app.route('/api/status', methods=['GET'])
def get_status():
    """Get simulator status (for GUI polling)"""
    slaves_count = int(os.environ.get("SLAVES", 3))
    
    # Build slave states
    slave_states = []
    for slave_id in range(1, slaves_count + 1):
        is_disabled = slave_id in DISABLED_SLAVES
        delay_config = SLAVE_DELAYS.get(slave_id, {})
        
        slave_states.append({
            'id': slave_id,
            'enabled': not is_disabled,
            'disabled': is_disabled,
            'status': 'DISABLED' if is_disabled else 'RUNNING',
            'delay_ms': delay_config.get('delay_ms', 0),
            'jitter_ms': delay_config.get('jitter_ms', 0)
        })
    
    return jsonify({
        'profile': get_active_profile(),
        'scenario': ACTIVE_SCENARIO,
        'slaves': slaves_count,
        'active_overrides': len(REGISTER_OVERRIDES),
        'overrides': {str(k): v for k, v in REGISTER_OVERRIDES.items()},
        'slave_states': slave_states
    })

# =============================================================================
# MAIN ENTRY POINT
# =============================================================================
def main():
    """Start unified simulator"""
    transport = os.environ.get("TRANSPORT", "tcp").lower()
    
    # Start profile retry thread if initial load failed
    if not profile_loaded:
        logger.info("Starting background profile loader...")
        profile_retry_thread = threading.Thread(target=retry_profile_loading, daemon=True)
        profile_retry_thread.start()
    
    # Start Modbus server in background thread
    modbus_thread = threading.Thread(target=run_modbus_server, daemon=True)
    modbus_thread.start()
    logger.info(f"✓ Modbus {transport.upper()} server thread started")
    
    # Start Flask GUI in main thread
    gui_port = int(os.environ.get("GUI_PORT", 5000))
    gui_host = os.environ.get("GUI_HOST", "0.0.0.0")
    
    logger.info(f"✓ Starting Flask GUI: {gui_host}:{gui_port}")
    
    # Disable werkzeug request logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    
    app.run(host=gui_host, port=gui_port, debug=False)

if __name__ == '__main__':
    main()
