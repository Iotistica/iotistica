#!/usr/bin/env python3
"""
Web GUI for OPC UA Simulator Control
Provides real-time control over profile selection and sensor monitoring
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

STATE_FILE = "/tmp/opcua_simulator_state.json"

def write_state(profile):
    """Write state to file for OPC UA server to read"""
    try:
        with open(STATE_FILE, "w") as f:
            json.dump({"profile": profile, "reload": True}, f)
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
    return {"profile": os.environ.get("PROFILE", "factory"), "reload": False}

# Load profile data from API
def load_profile_data():
    """Load profile data from API (profile_configs table in PostgreSQL)"""
    import urllib.request
    import ssl
    import time
    
    API_URL = os.environ.get("OPCUA_API_URL", "http://api:3002")
    
    # Create SSL context that accepts self-signed certificates
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    
    # Try API with retries
    max_retries = 3
    for attempt in range(max_retries):
        try:
            url = f"{API_URL}/api/v1/profiles/datapoints?protocol=opcua"
            req = urllib.request.Request(url, headers={'User-Agent': 'opcua-gui/1.0'})
            with urllib.request.urlopen(req, timeout=3, context=ssl_context) as response:
                profile_data = json.loads(response.read().decode())
                logger.info(f"Loaded {len(profile_data)} profiles from API")
                return profile_data
        except Exception as e:
            if attempt < max_retries - 1:
                logger.warning(f"API attempt {attempt+1} failed, retrying... {e}")
                time.sleep(1)
            else:
                logger.error(f"API failed after {max_retries} attempts: {e}")
    
    # No fallback - return empty if API fails
    logger.warning("No profiles loaded - API unavailable")
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
    """Render main dashboard"""
    return render_template('index.html')

@app.route('/api/status', methods=['GET'])
def get_status():
    """Get current simulator status"""
    state = read_state()
    current_profile = state.get("profile", "factory")
    profiles = get_profile_data()
    
    # Get current profile details
    profile_info = profiles.get(current_profile, {})
    
    # Count sensors
    sensor_count = 0
    sensor_types = {}
    if "sensors" in profile_info:
        for sensor_group in profile_info["sensors"]:
            count = sensor_group.get("count", 1)
            model = sensor_group.get("model", "unknown")
            sensor_count += count
            sensor_types[model] = sensor_types.get(model, 0) + count
    
    return jsonify({
        "status": "running",
        "current_profile": current_profile,
        "profile_description": profile_info.get("description", ""),
        "sensor_count": sensor_count,
        "sensor_types": sensor_types,
        "available_profiles": list(profiles.keys()),
        "endpoint": "opc.tcp://localhost:4840/iotistic/simulator"
    })

@app.route('/api/profiles', methods=['GET'])
def list_profiles():
    """List all available profiles"""
    profiles = get_profile_data()
    
    # Transform to summary format
    profiles_list = []
    for name, data in profiles.items():
        sensor_count = sum(s.get("count", 1) for s in data.get("sensors", []))
        profiles_list.append({
            "name": name,
            "description": data.get("description", ""),
            "sensor_count": sensor_count
        })
    
    return jsonify({"profiles": profiles_list})

@app.route('/api/profile', methods=['POST'])
def set_profile():
    """Set active profile (triggers hot reload)"""
    data = request.get_json()
    profile_name = data.get("profile")
    
    if not profile_name:
        return jsonify({"error": "Missing profile name"}), 400
    
    profiles = get_profile_data()
    if profile_name not in profiles:
        return jsonify({"error": f"Profile '{profile_name}' not found"}), 404
    
    # Write new profile to state file
    write_state(profile_name)
    
    logger.info(f"Profile changed to: {profile_name}")
    return jsonify({
        "success": True,
        "profile": profile_name,
        "message": "Profile change triggered. Server will reload automatically."
    })

@app.route('/api/sensors', methods=['GET'])
def list_sensors():
    """List all sensors in current profile"""
    state = read_state()
    current_profile = state.get("profile", "factory")
    profiles = get_profile_data()
    
    profile_info = profiles.get(current_profile, {})
    
    # Build sensor list
    sensors = []
    for sensor_group in profile_info.get("sensors", []):
        folder = sensor_group.get("folder", "Unknown")
        subfolder = sensor_group.get("subfolder")
        zone = sensor_group.get("zone")
        prefix = sensor_group.get("prefix", "Sensor")
        model = sensor_group.get("model", "unknown")
        count = sensor_group.get("count", 1)
        unit = sensor_group.get("unit", "")
        
        # Build path
        path_parts = [folder]
        if subfolder:
            path_parts.append(subfolder)
        if zone:
            path_parts.append(zone)
        path = "/".join(path_parts)
        
        for i in range(count):
            sensors.append({
                "name": f"{prefix}_{i+1}",
                "path": path,
                "full_path": f"{path}/{prefix}_{i+1}",
                "type": model,
                "unit": unit
            })
    
    return jsonify({"sensors": sensors, "count": len(sensors)})

@app.route('/api/reload-cache', methods=['POST'])
def reload_cache():
    """Force reload profile data cache"""
    global profile_data_cache
    profile_data_cache = None
    profiles = get_profile_data()
    return jsonify({
        "success": True,
        "message": f"Cache reloaded, {len(profiles)} profiles available"
    })

if __name__ == '__main__':
    port = int(os.environ.get('WEB_PORT', 5001))
    app.run(host='0.0.0.0', port=port, debug=True)
