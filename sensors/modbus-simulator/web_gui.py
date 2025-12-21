#!/usr/bin/env python3
"""
Web GUI for Modbus Simulator Control
Provides real-time control over register values and scenarios
"""
import os
import json
import logging
from flask import Flask, render_template, jsonify, request
from flask_cors import CORS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# Shared state with modbus_simulator.py
REGISTER_OVERRIDES = {}  # {address: override_value}
DISABLED_SLAVES = set()  # Set of disabled slave unit IDs (simulates device failure)
SLAVE_DELAYS = {}  # {slave_id: {"delay_ms": int, "jitter_ms": int}} - Response delay simulation
REGISTER_ACCESS_LOG = {}  # {(slave_id, reg_type, address): {reads: int, writes: int, last_read: float, last_write: float}}
EXCEPTION_INJECTIONS = {}  # {(slave_id, reg_type, address): exception_code} or {slave_id: exception_code} for slave-wide
STATE_FILE = "/tmp/modbus_simulator_state.json"

# Modbus exception codes
EXCEPTION_CODES = {
    "illegal_function": 0x01,
    "illegal_address": 0x02,
    "illegal_value": 0x03,
    "slave_failure": 0x04,
    "acknowledge": 0x05,
    "slave_busy": 0x06
}

def write_state(profile):
    """Write state to file for Modbus process to read"""
    try:
        with open(STATE_FILE, "w") as f:
            json.dump({"profile": profile}, f)
        logger.info(f"Wrote profile state: {profile}")
    except Exception as e:
        logger.error(f"Failed to write state file: {e}")

def read_state():
    """Read current state from file"""
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r") as f:
                return json.load(f)
    except Exception as e:
        logger.error(f"Failed to read state file: {e}")
    return {"profile": os.environ.get("MODBUS_PROFILE", "Generic")}

# Load profile data (same function as simulator)
def load_profile_data():
    """Load profile data points from API or fallback to local file"""
    import urllib.request
    import time
    
    API_URL = os.environ.get("MODBUS_API_URL", "http://api:3002")
    JSON_FILE = os.environ.get("MODBUS_PROFILE_JSON", "./profiles/dataPoints.json")
    
    # Try API first
    max_retries = 2
    for attempt in range(max_retries):
        try:
            url = f"{API_URL}/api/v1/profiles/datapoints?protocol=modbus"
            req = urllib.request.Request(url, headers={'User-Agent': 'modbus-gui/1.0'})
            with urllib.request.urlopen(req, timeout=3) as response:
                profile_data = json.loads(response.read().decode())
                logger.info(f"Loaded profile data from API ({len(profile_data)} profiles)")
                return profile_data
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(1)
            else:
                logger.warning(f"API failed, using fallback: {e}")
    
    # Fallback to file
    try:
        with open(JSON_FILE, "r") as f:
            profile_data = json.load(f)
            logger.info(f"Loaded profile data from file ({len(profile_data)} profiles)")
            return profile_data
    except Exception as e:
        logger.error(f"Failed to load profile data: {e}")
        return {}

profile_data_cache = None

def get_profile_data():
    """Get profile data with caching"""
    global profile_data_cache
    if profile_data_cache is None:
        profile_data_cache = load_profile_data()
    return profile_data_cache

@app.route('/')
def index():
    """Main GUI page"""
    profiles = list(get_profile_data().keys())
    current_profile = os.environ.get("MODBUS_PROFILE", "Generic")
    return render_template('index.html', profiles=profiles, current_profile=current_profile)

@app.route('/api/profiles')
def get_profiles():
    """Get list of available profiles"""
    profiles = list(get_profile_data().keys())
    return jsonify({"profiles": profiles})

@app.route('/api/datapoints/<profile>')
def get_datapoints(profile):
    """Get data points for a specific profile"""
    profile_data = get_profile_data()
    data_points = profile_data.get(profile, {}).get("dataPoints", [])
    return jsonify({"dataPoints": data_points})

@app.route('/api/overrides', methods=['GET'])
def get_overrides():
    """Get current register overrides"""
    return jsonify(REGISTER_OVERRIDES)

@app.route('/api/overrides/<int:address>', methods=['PUT'])
def set_override(address):
    """Set override for a specific register"""
    data = request.json
    REGISTER_OVERRIDES[address] = {
        "base": data.get("base", 100),
        "noise_pct": data.get("noise_pct", 0.05)
    }
    logger.info(f"Override set for address {address}: {REGISTER_OVERRIDES[address]}")
    return jsonify({"success": True, "address": address, "override": REGISTER_OVERRIDES[address]})

@app.route('/api/overrides/<int:address>', methods=['DELETE'])
def delete_override(address):
    """Remove override for a specific register"""
    if address in REGISTER_OVERRIDES:
        del REGISTER_OVERRIDES[address]
        logger.info(f"Override removed for address {address}")
    return jsonify({"success": True, "address": address})

@app.route('/api/overrides', methods=['DELETE'])
def clear_overrides():
    """Clear all overrides"""
    REGISTER_OVERRIDES.clear()
    logger.info("All overrides cleared")
    return jsonify({"success": True})

@app.route('/api/scenario/<scenario_name>', methods=['POST'])
def apply_scenario(scenario_name):
    """Apply predefined scenario"""
    scenarios = {
        "normal": {},  # Clear all overrides
        "high_load": {
            # COMAP High load scenario (updated addresses for modbus-serial +1 offset)
            99: {"base": 1800, "noise_pct": 0.15},   # engine_rpm: High RPM (1800)
            139: {"base": 150, "noise_pct": 0.20},   # power_kw: High power (150kW)
            149: {"base": 95, "noise_pct": 0.10},    # engine_temp: Elevated temp (95°C)
        },
        "fault": {
            # COMAP Fault condition scenario
            149: {"base": 110, "noise_pct": 0.30},   # engine_temp: CRITICAL temp (110°C)
            159: {"base": 10, "noise_pct": 0.50},    # fuel_level: LOW fuel (10%)
            99: {"base": 2100, "noise_pct": 0.25},   # engine_rpm: Overspeed (2100 RPM)
        },
        "unstable": {
            # COMAP Unstable readings scenario
            99: {"base": 1500, "noise_pct": 0.50},   # engine_rpm: Erratic RPM (±50%)
            129: {"base": 50, "noise_pct": 0.30},    # frequency: Unstable frequency (±30%)
            109: {"base": 230, "noise_pct": 0.25},   # gen_voltage_a: Voltage fluctuation (±25%)
            110: {"base": 230, "noise_pct": 0.25},   # gen_voltage_b: Voltage fluctuation
            111: {"base": 230, "noise_pct": 0.25},   # gen_voltage_c: Voltage fluctuation
        }
    }
    
    if scenario_name == "normal":
        REGISTER_OVERRIDES.clear()
    elif scenario_name in scenarios:
        REGISTER_OVERRIDES.update(scenarios[scenario_name])
    else:
        return jsonify({"success": False, "error": "Unknown scenario"}), 400
    
    logger.info(f"Applied scenario: {scenario_name}")
    return jsonify({"success": True, "scenario": scenario_name, "overrides": REGISTER_OVERRIDES})

@app.route('/api/profile/switch/<profile_name>', methods=['POST'])
def switch_profile(profile_name):
    """Switch active profile dynamically"""
    try:
        profile_data = get_profile_data()
        if profile_name in profile_data:
            write_state(profile_name)
            return jsonify({
                "success": True,
                "profile": profile_name,
                "message": f"Switched to {profile_name}"
            })
        else:
            return jsonify({
                "success": False,
                "error": f"Unknown profile: {profile_name}"
            }), 400
    except Exception as e:
        logger.error(f"Failed to switch profile: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/status')
def get_status():
    """Get simulator status"""
    state = read_state()
    active_profile = state.get("profile", os.environ.get("MODBUS_PROFILE", "Generic"))
    
    total_slaves = int(os.environ.get("MODBUS_SLAVES", 3))
    slave_states = [
        {
            "id": i,
            "enabled": i not in DISABLED_SLAVES,
            "status": "online" if i not in DISABLED_SLAVES else "offline",
            "delay_ms": SLAVE_DELAYS.get(i, {}).get("delay_ms", 0),
            "jitter_ms": SLAVE_DELAYS.get(i, {}).get("jitter_ms", 0)
        }
        for i in range(1, total_slaves + 1)
    ]
    
    return jsonify({
        "profile": active_profile,
        "slaves": total_slaves,
        "slave_states": slave_states,
        "port": int(os.environ.get("MODBUS_PORT", 502)),
        "active_overrides": len(REGISTER_OVERRIDES),
        "overrides": REGISTER_OVERRIDES
    })

@app.route('/api/slave/<int:slave_id>/toggle', methods=['POST'])
def toggle_slave(slave_id):
    """Enable or disable a specific slave (simulates device failure)"""
    total_slaves = int(os.environ.get("MODBUS_SLAVES", 3))
    
    if slave_id < 1 or slave_id > total_slaves:
        return jsonify({
            "success": False,
            "error": f"Invalid slave ID {slave_id} (must be 1-{total_slaves})"
        }), 400
    
    if slave_id in DISABLED_SLAVES:
        DISABLED_SLAVES.remove(slave_id)
        action = "enabled"
    else:
        DISABLED_SLAVES.add(slave_id)
        action = "disabled"
    
    # Save state to file for cross-process communication
    try:
        with open(STATE_FILE, 'w') as f:
            json.dump({'disabled_slaves': list(DISABLED_SLAVES)}, f)
    except Exception as e:
        logger.error(f"Failed to save state: {e}")
    
    logger.info(f"Slave {slave_id} {action}")
    
    return jsonify({
        "success": True,
        "slave_id": slave_id,
        "enabled": slave_id not in DISABLED_SLAVES,
        "message": f"Slave {slave_id} {action}"
    })

@app.route('/api/slave/<int:slave_id>/delay', methods=['POST'])
def set_slave_delay(slave_id):
    """Set response delay for a specific slave (simulates slow/unreliable device)"""
    total_slaves = int(os.environ.get("MODBUS_SLAVES", 3))
    
    if slave_id < 1 or slave_id > total_slaves:
        return jsonify({
            "success": False,
            "error": f"Invalid slave ID {slave_id} (must be 1-{total_slaves})"
        }), 400
    
    data = request.json
    delay_ms = int(data.get("delay_ms", 0))
    jitter_ms = int(data.get("jitter_ms", 0))
    
    # Validate ranges
    if delay_ms < 0 or delay_ms > 10000:
        return jsonify({
            "success": False,
            "error": "Delay must be between 0-10000ms"
        }), 400
    
    if jitter_ms < 0 or jitter_ms > 1000:
        return jsonify({
            "success": False,
            "error": "Jitter must be between 0-1000ms"
        }), 400
    
    # Store delay config
    if delay_ms == 0 and jitter_ms == 0:
        # Remove delay if both are 0
        SLAVE_DELAYS.pop(slave_id, None)
        logger.info(f"Slave {slave_id} delay cleared")
    else:
        SLAVE_DELAYS[slave_id] = {
            "delay_ms": delay_ms,
            "jitter_ms": jitter_ms
        }
        logger.info(f"Slave {slave_id} delay set: {delay_ms}ms ±{jitter_ms}ms")
    
    return jsonify({
        "success": True,
        "slave_id": slave_id,
        "delay_ms": delay_ms,
        "jitter_ms": jitter_ms,
        "message": f"Slave {slave_id} delay: {delay_ms}ms ±{jitter_ms}ms"
    })

@app.route('/api/exceptions', methods=['GET'])
def get_exception_injections():
    """Get current exception injections"""
    # Convert to readable format
    exceptions = []
    for key, code in EXCEPTION_INJECTIONS.items():
        if isinstance(key, tuple):
            slave_id, reg_type, address = key
            exceptions.append({
                "type": "register",
                "slave_id": slave_id,
                "register_type": reg_type,
                "address": address,
                "exception_code": code,
                "exception_name": next((name for name, val in EXCEPTION_CODES.items() if val == code), "unknown")
            })
        else:
            exceptions.append({
                "type": "slave",
                "slave_id": key,
                "exception_code": code,
                "exception_name": next((name for name, val in EXCEPTION_CODES.items() if val == code), "unknown")
            })
    
    return jsonify({
        "count": len(exceptions),
        "injections": exceptions,
        "available_codes": EXCEPTION_CODES
    })

@app.route('/api/exception/slave/<int:slave_id>', methods=['POST'])
def inject_slave_exception(slave_id):
    """Inject exception for all operations on a slave"""
    total_slaves = int(os.environ.get("MODBUS_SLAVES", 3))
    
    if slave_id < 1 or slave_id > total_slaves:
        return jsonify({
            "success": False,
            "error": f"Invalid slave ID {slave_id}"
        }), 400
    
    data = request.json
    exception_name = data.get("exception")
    
    if exception_name not in EXCEPTION_CODES:
        return jsonify({
            "success": False,
            "error": f"Invalid exception. Use one of: {list(EXCEPTION_CODES.keys())}"
        }), 400
    
    exception_code = EXCEPTION_CODES[exception_name]
    EXCEPTION_INJECTIONS[slave_id] = exception_code
    
    logger.info(f"Injecting {exception_name} (0x{exception_code:02X}) for slave {slave_id}")
    
    return jsonify({
        "success": True,
        "slave_id": slave_id,
        "exception": exception_name,
        "code": f"0x{exception_code:02X}",
        "message": f"Slave {slave_id} will return {exception_name} for all operations"
    })

@app.route('/api/exception/clear', methods=['POST'])
def clear_exceptions():
    """Clear all exception injections"""
    data = request.json or {}
    
    if "slave_id" in data:
        # Clear specific slave
        slave_id = int(data["slave_id"])
        
        # Remove slave-wide exception
        if slave_id in EXCEPTION_INJECTIONS:
            del EXCEPTION_INJECTIONS[slave_id]
        
        # Remove all register-specific exceptions for this slave
        keys_to_remove = [k for k in EXCEPTION_INJECTIONS.keys() if isinstance(k, tuple) and k[0] == slave_id]
        for key in keys_to_remove:
            del EXCEPTION_INJECTIONS[key]
        
        logger.info(f"Cleared all exceptions for slave {slave_id}")
        return jsonify({"success": True, "message": f"Cleared exceptions for slave {slave_id}"})
    else:
        # Clear all
        EXCEPTION_INJECTIONS.clear()
        logger.info("Cleared all exception injections")
        return jsonify({"success": True, "message": "Cleared all exceptions"})

@app.route('/api/access-log', methods=['GET'])
def get_access_log():
    """Get register access statistics"""
    import time
    
    # Convert log to readable format
    log_data = []
    for key, stats in REGISTER_ACCESS_LOG.items():
        slave_id, reg_type, address = key
        log_data.append({
            "slave_id": slave_id,
            "register_type": reg_type,
            "address": address,
            "reads": stats.get("reads", 0),
            "writes": stats.get("writes", 0),
            "last_read": stats.get("last_read"),
            "last_write": stats.get("last_write"),
            "last_read_ago": f"{time.time() - stats['last_read']:.1f}s" if stats.get("last_read") else None,
            "last_write_ago": f"{time.time() - stats['last_write']:.1f}s" if stats.get("last_write") else None
        })
    
    # Sort by total access (reads + writes) descending
    log_data.sort(key=lambda x: x['reads'] + x['writes'], reverse=True)
    
    return jsonify({
        "total_registers": len(log_data),
        "total_reads": sum(x['reads'] for x in log_data),
        "total_writes": sum(x['writes'] for x in log_data),
        "log": log_data
    })

@app.route('/api/access-log/export/<format>', methods=['GET'])
def export_access_log(format):
    """Export access log as CSV or JSON"""
    import time
    import io
    import csv
    from flask import make_response
    
    # Build log data
    log_data = []
    for key, stats in REGISTER_ACCESS_LOG.items():
        slave_id, reg_type, address = key
        log_data.append({
            "slave_id": slave_id,
            "register_type": reg_type,
            "address": address,
            "reads": stats.get("reads", 0),
            "writes": stats.get("writes", 0),
            "last_read": stats.get("last_read"),
            "last_write": stats.get("last_write")
        })
    
    log_data.sort(key=lambda x: x['reads'] + x['writes'], reverse=True)
    
    if format == 'json':
        response = make_response(json.dumps(log_data, indent=2))
        response.headers['Content-Type'] = 'application/json'
        response.headers['Content-Disposition'] = 'attachment; filename=modbus_access_log.json'
        return response
    
    elif format == 'csv':
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=['slave_id', 'register_type', 'address', 'reads', 'writes', 'last_read', 'last_write'])
        writer.writeheader()
        writer.writerows(log_data)
        
        response = make_response(output.getvalue())
        response.headers['Content-Type'] = 'text/csv'
        response.headers['Content-Disposition'] = 'attachment; filename=modbus_access_log.csv'
        return response
    
    return jsonify({"error": "Invalid format. Use 'json' or 'csv'"}), 400

@app.route('/api/access-log/clear', methods=['POST'])
def clear_access_log():
    """Clear all access statistics"""
    REGISTER_ACCESS_LOG.clear()
    logger.info("Access log cleared")
    return jsonify({"success": True, "message": "Access log cleared"})

@app.route('/api/access-log/top/<int:limit>', methods=['GET'])
def get_top_accessed(limit):
    """Get top N most accessed registers"""
    import time
    
    log_data = []
    for key, stats in REGISTER_ACCESS_LOG.items():
        slave_id, reg_type, address = key
        total_access = stats.get("reads", 0) + stats.get("writes", 0)
        if total_access > 0:
            log_data.append({
                "slave_id": slave_id,
                "register_type": reg_type,
                "address": address,
                "reads": stats.get("reads", 0),
                "writes": stats.get("writes", 0),
                "total_access": total_access,
                "last_access": max(stats.get("last_read", 0), stats.get("last_write", 0))
            })
    
    # Sort by total access and take top N
    log_data.sort(key=lambda x: x['total_access'], reverse=True)
    top_registers = log_data[:limit]
    
    return jsonify({
        "limit": limit,
        "count": len(top_registers),
        "registers": top_registers
    })

if __name__ == '__main__':
    port = int(os.environ.get("GUI_PORT", 5000))
    host = os.environ.get("GUI_HOST", "0.0.0.0")
    logger.info(f"Starting Modbus Simulator GUI on {host}:{port}")
    app.run(host=host, port=port, debug=True)
