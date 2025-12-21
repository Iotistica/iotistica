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

def write_state(vendor):
    """Write state to file for Modbus process to read"""
    try:
        with open(STATE_FILE, "w") as f:
            json.dump({"vendor": vendor}, f)
        logger.info(f"Wrote vendor state: {vendor}")
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
    return {"vendor": os.environ.get("MODBUS_VENDOR", "Generic")}

# Load vendor data (same function as simulator)
def load_vendor_data():
    """Load vendor data points from API or fallback to local file"""
    import urllib.request
    import time
    
    API_URL = os.environ.get("MODBUS_API_URL", "http://api:3002")
    JSON_FILE = os.environ.get("MODBUS_VENDOR_JSON", "./vendors/dataPoints.json")
    
    # Try API first
    max_retries = 2
    for attempt in range(max_retries):
        try:
            url = f"{API_URL}/api/v1/vendors/datapoints?protocol=modbus"
            req = urllib.request.Request(url, headers={'User-Agent': 'modbus-gui/1.0'})
            with urllib.request.urlopen(req, timeout=3) as response:
                vendor_data = json.loads(response.read().decode())
                logger.info(f"Loaded vendor data from API ({len(vendor_data)} vendors)")
                return vendor_data
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(1)
            else:
                logger.warning(f"API failed, using fallback: {e}")
    
    # Fallback to file
    try:
        with open(JSON_FILE, "r") as f:
            vendor_data = json.load(f)
            logger.info(f"Loaded vendor data from file ({len(vendor_data)} vendors)")
            return vendor_data
    except Exception as e:
        logger.error(f"Failed to load vendor data: {e}")
        return {}

vendor_data_cache = None

def get_vendor_data():
    """Get vendor data with caching"""
    global vendor_data_cache
    if vendor_data_cache is None:
        vendor_data_cache = load_vendor_data()
    return vendor_data_cache

@app.route('/')
def index():
    """Main GUI page"""
    vendors = list(get_vendor_data().keys())
    current_vendor = os.environ.get("MODBUS_VENDOR", "Generic")
    return render_template('index.html', vendors=vendors, current_vendor=current_vendor)

@app.route('/api/vendors')
def get_vendors():
    """Get list of available vendors"""
    vendors = list(get_vendor_data().keys())
    return jsonify({"vendors": vendors})

@app.route('/api/datapoints/<vendor>')
def get_datapoints(vendor):
    """Get data points for a specific vendor"""
    vendor_data = get_vendor_data()
    data_points = vendor_data.get(vendor, {}).get("dataPoints", [])
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

@app.route('/api/vendor/switch/<vendor_name>', methods=['POST'])
def switch_vendor(vendor_name):
    """Switch active vendor dynamically"""
    try:
        vendor_data = get_vendor_data()
        if vendor_name in vendor_data:
            write_state(vendor_name)
            return jsonify({
                "success": True,
                "vendor": vendor_name,
                "message": f"Switched to {vendor_name}"
            })
        else:
            return jsonify({
                "success": False,
                "error": f"Unknown vendor: {vendor_name}"
            }), 400
    except Exception as e:
        logger.error(f"Failed to switch vendor: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/status')
def get_status():
    """Get simulator status"""
    state = read_state()
    active_vendor = state.get("vendor", os.environ.get("MODBUS_VENDOR", "Generic"))
    
    return jsonify({
        "vendor": active_vendor,
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
