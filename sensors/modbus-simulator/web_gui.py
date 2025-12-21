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
REGISTER_OVERRIDES = {}
STATE_FILE = "/tmp/modbus_simulator_state.json"

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
    
    return jsonify({
        "profile": active_profile,
        "slaves": int(os.environ.get("MODBUS_SLAVES", 3)),
        "port": int(os.environ.get("MODBUS_PORT", 502)),
        "active_overrides": len(REGISTER_OVERRIDES),
        "overrides": REGISTER_OVERRIDES
    })

if __name__ == '__main__':
    port = int(os.environ.get("GUI_PORT", 5000))
    host = os.environ.get("GUI_HOST", "0.0.0.0")
    logger.info(f"Starting Modbus Simulator GUI on {host}:{port}")
    app.run(host=host, port=port, debug=True)
