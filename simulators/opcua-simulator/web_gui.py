#!/usr/bin/env python3
"""
Web GUI for OPC UA Simulator Control
Provides real-time control over profile selection and device monitoring
"""
import os
import json
import logging
from pathlib import Path
from flask import Flask, render_template, jsonify, request
from flask_cors import CORS
from lib.profiles import load_all_profiles
from lib.models import MODEL_REGISTRY

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


def get_local_profile_path(profile_name):
    """Get absolute path to local profile JSON file by profile key."""
    profiles_dir = Path(__file__).resolve().parent / "profiles"
    return profiles_dir / f"{profile_name.lower()}.json"


def is_local_profile(profile_name):
    """Return True if profile is backed by local JSON file."""
    return get_local_profile_path(profile_name).exists()


def load_local_profile_json(profile_name):
    """Load local profile JSON by profile key."""
    profile_path = get_local_profile_path(profile_name)
    if not profile_path.exists():
        return None, profile_path, f"Profile '{profile_name}' is not a local JSON profile"

    try:
        with open(profile_path, "r", encoding="utf-8") as f:
            profile_json = json.load(f)
    except Exception as e:
        logger.error(f"Failed to read profile file {profile_path}: {e}")
        return None, profile_path, f"Failed to read profile '{profile_name}'"

    if not isinstance(profile_json.get("devices"), list):
        return None, profile_path, f"Profile '{profile_name}' has invalid devices format"

    return profile_json, profile_path, None


def save_local_profile_json(profile_name, profile_json):
    """Persist local profile JSON by profile key."""
    profile_path = get_local_profile_path(profile_name)
    try:
        with open(profile_path, "w", encoding="utf-8") as f:
            json.dump(profile_json, f, indent=2)
            f.write("\n")
    except Exception as e:
        logger.error(f"Failed to write profile file {profile_path}: {e}")
        return False, f"Failed to update profile '{profile_name}'"
    return True, None


def validate_stateful_config(config):
    """Validate strict device behavior state config."""
    if not isinstance(config, dict):
        return "config must be a JSON object"

    active_state = config.get("active_state")
    states = config.get("states")

    if not isinstance(active_state, str) or not active_state.strip():
        return "config.active_state is required and must be a non-empty string"
    if not isinstance(states, dict) or not states:
        return "config.states is required and must be a non-empty object"
    if active_state not in states:
        return f"config.active_state '{active_state}' not found in config.states"

    for state_name, state_cfg in states.items():
        if not isinstance(state_cfg, dict):
            return f"config.states.{state_name} must be an object"

    return None

# Load profile data from local JSON profiles
def load_local_profile_data():
    """Load profile data from local JSON profiles directory."""
    try:
        profiles = load_all_profiles()
        local_profiles = {}
        for key, profile in profiles.items():
            local_profiles[key] = {
                "name": profile.name,
                "description": profile.description,
                "devices": profile.devices,
            }
        logger.info(f"Loaded {len(local_profiles)} profiles from local JSON files")
        return local_profiles
    except Exception as e:
        logger.error(f"Failed to load local JSON profiles: {e}")
        return {}


def load_profile_data_from_api():
    """Load profile data from API (profile_configs table in PostgreSQL)."""
    import urllib.request
    import ssl
    import time
    
    API_URL = os.environ.get("API_URL", "http://api:3002")
    API_KEY = os.environ.get("API_KEY")  # Required: from api_keys table
    
    if not API_KEY:
        logger.info("API_KEY not set; skipping API profile loading")
        return {}
    
    # Create SSL context that accepts self-signed certificates
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    
    # Try API with retries
    max_retries = 3
    for attempt in range(max_retries):
        try:
            # Use simulator endpoint
            url = f"{API_URL}/api/v1/profiles/sim/datapoints?protocol=opcua"
            headers = {
                'User-Agent': 'opcua-gui/1.0',
                'Authorization': f'Bearer {API_KEY}'
            }
            
            req = urllib.request.Request(url, headers=headers)
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
    
    logger.warning("API profile loading unavailable")
    return {}


def load_profile_data():
    """Load profile data with API-first strategy and local JSON fallback."""
    api_profiles = load_profile_data_from_api()
    if api_profiles:
        return api_profiles

    local_profiles = load_local_profile_data()
    if local_profiles:
        logger.info("Using local JSON profiles for web GUI")
        return local_profiles

    logger.error("No profiles available from API or local JSON files")
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
    
    # Count devices
    device_count = 0
    device_types = {}
    if "devices" in profile_info:
        for device_group in profile_info["devices"]:
            count = device_group.get("count", 1)
            model = device_group.get("model", "unknown")
            device_count += count
            device_types[model] = device_types.get(model, 0) + count
    
    return jsonify({
        "status": "running",
        "current_profile": current_profile,
        "profile_description": profile_info.get("description", ""),
        "device_count": device_count,
        "device_types": device_types,
        "available_profiles": list(profiles.keys()),
        "endpoint": "opc.tcp://localhost:4840"
    })

@app.route('/api/profiles', methods=['GET'])
def list_profiles():
    """List all available profiles"""
    profiles = get_profile_data()
    
    # Transform to summary format
    profiles_list = []
    for name, data in profiles.items():
        device_count = sum(d.get("count", 1) for d in data.get("devices", []))
        profiles_list.append({
            "name": name,
            "description": data.get("description", ""),
            "device_count": device_count
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

@app.route('/api/devices', methods=['GET'])
def list_devices():
    """List all devices in current profile"""
    state = read_state()
    current_profile = state.get("profile", "factory")
    profiles = get_profile_data()
    
    profile_info = profiles.get(current_profile, {})
    
    # Build device list
    devices = []
    for device_group in profile_info.get("devices", []):
        folder = device_group.get("folder", "Unknown")
        subfolder = device_group.get("subfolder")
        zone = device_group.get("zone")
        prefix = device_group.get("prefix", "Device")
        model = device_group.get("model", "unknown")
        count = device_group.get("count", 1)
        unit = device_group.get("unit", "")
        
        # Build path
        path_parts = [folder]
        if subfolder:
            path_parts.append(subfolder)
        if zone:
            path_parts.append(zone)
        path = "/".join(path_parts)
        
        for i in range(count):
            devices.append({
                "name": f"{prefix}_{i+1}",
                "path": path,
                "full_path": f"{path}/{prefix}_{i+1}",
                "type": model,
                "unit": unit
            })
    
    return jsonify({"devices": devices, "count": len(devices)})


@app.route('/api/device-groups', methods=['GET'])
def list_device_groups():
    """List all device groups for the active local profile."""
    state = read_state()
    current_profile = request.args.get("profile") or state.get("profile", "factory")

    profile_json, _, error = load_local_profile_json(current_profile)
    if error:
        return jsonify({"error": error}), 400

    groups = []
    for index, group in enumerate(profile_json.get("devices", [])):
        groups.append({
            "index": index,
            "folder": group.get("folder", ""),
            "prefix": group.get("prefix", ""),
            "model": group.get("model", ""),
            "count": group.get("count", 1),
            "unit": group.get("unit", ""),
            "subfolder": group.get("subfolder", ""),
            "zone": group.get("zone", ""),
            "config": group.get("config", {}),
        })

    return jsonify({
        "profile": current_profile,
        "groups": groups,
        "count": len(groups)
    })


@app.route('/api/device-groups/schema', methods=['GET'])
def get_device_group_schema():
    """Return schema-like metadata for the selected profile's device groups."""
    state = read_state()
    profile_name = request.args.get("profile") or state.get("profile", "factory")
    # Keep schema aligned with add/edit/remove endpoints: prefer local JSON when present.
    if is_local_profile(profile_name):
        profile_json, _, error = load_local_profile_json(profile_name)
        if error:
            return jsonify({"error": error}), 400
        devices = profile_json.get("devices", [])
    else:
        profiles = get_profile_data()
        profile = profiles.get(profile_name)
        if not profile:
            return jsonify({"error": f"Profile '{profile_name}' not found"}), 404
        devices = profile.get("devices", [])
    required_base = ["folder", "prefix", "model", "count"]

    all_fields = set()
    models = set()
    config_keys = set()
    state_names = set()

    for group in devices:
        if not isinstance(group, dict):
            continue
        all_fields.update(group.keys())
        model = group.get("model")
        if model:
            models.add(str(model))
        config = group.get("config")
        if isinstance(config, dict):
            states = config.get("states")
            if isinstance(states, dict):
                state_names.update(states.keys())
                for state_cfg in states.values():
                    if isinstance(state_cfg, dict):
                        config_keys.update(state_cfg.keys())

    optional_fields = sorted(
        [f for f in all_fields if f not in set(required_base + ["config"])]
    )

    # Prefer profile-specific model list; fallback to all known models
    model_list = sorted(models) if models else sorted(MODEL_REGISTRY.keys())

    sample_group = devices[0] if devices and isinstance(devices[0], dict) else {}

    return jsonify({
        "profile": profile_name,
        "editable": is_local_profile(profile_name),
        "requiredFields": required_base,
        "optionalFields": optional_fields,
        "models": model_list,
        "stateNames": sorted(state_names),
        "configKeys": sorted(config_keys),
        "sampleGroup": sample_group,
    })


@app.route('/api/devices', methods=['POST'])
def add_device_group():
    """Add a device group to the active local profile and trigger reload."""
    global profile_data_cache

    data = request.get_json(silent=True) or {}

    state = read_state()
    current_profile = data.get("profile") or state.get("profile", "factory")
    profile_json, _, error = load_local_profile_json(current_profile)
    if error:
        return jsonify({"error": error}), 400

    folder = str(data.get("folder", "")).strip()
    prefix = str(data.get("prefix", "")).strip()
    model = str(data.get("model", "")).strip().lower()
    unit = str(data.get("unit", "")).strip()
    subfolder = str(data.get("subfolder", "")).strip()
    zone = str(data.get("zone", "")).strip()
    config = data.get("config") or {}

    try:
        count = int(data.get("count", 1))
    except (TypeError, ValueError):
        return jsonify({"error": "count must be a positive integer"}), 400

    if not folder:
        return jsonify({"error": "folder is required"}), 400
    if not prefix:
        return jsonify({"error": "prefix is required"}), 400
    if count <= 0:
        return jsonify({"error": "count must be greater than 0"}), 400
    if model not in MODEL_REGISTRY:
        return jsonify({
            "error": f"Invalid model '{model}'",
            "valid_models": sorted(MODEL_REGISTRY.keys())
        }), 400
    config_error = validate_stateful_config(config)
    if config_error:
        return jsonify({"error": config_error}), 400

    devices = profile_json.get("devices")

    new_group = {
        "folder": folder,
        "prefix": prefix,
        "model": model,
        "count": count,
    }
    if unit:
        new_group["unit"] = unit
    if subfolder:
        new_group["subfolder"] = subfolder
    if zone:
        new_group["zone"] = zone
    if config:
        new_group["config"] = config

    devices.append(new_group)
    profile_json["devices"] = devices

    saved, save_error = save_local_profile_json(current_profile, profile_json)
    if not saved:
        return jsonify({"error": save_error}), 500

    # Invalidate cache and trigger simulator reload for current profile.
    profile_data_cache = None
    write_state(current_profile)

    logger.info(
        f"Added device group to profile '{current_profile}': "
        f"folder={folder}, prefix={prefix}, model={model}, count={count}"
    )

    return jsonify({
        "success": True,
        "profile": current_profile,
        "added": new_group,
        "message": "Device group added and simulator reload triggered"
    })


@app.route('/api/device-groups/<int:group_index>', methods=['PUT'])
def edit_device_group(group_index):
    """Edit a device group in the active local profile and trigger reload."""
    global profile_data_cache

    data = request.get_json(silent=True) or {}
    state = read_state()
    current_profile = data.get("profile") or state.get("profile", "factory")

    profile_json, _, error = load_local_profile_json(current_profile)
    if error:
        return jsonify({"error": error}), 400

    devices = profile_json.get("devices", [])
    if group_index < 0 or group_index >= len(devices):
        return jsonify({"error": f"Device group index {group_index} out of range"}), 404

    folder = str(data.get("folder", "")).strip()
    prefix = str(data.get("prefix", "")).strip()
    model = str(data.get("model", "")).strip().lower()
    unit = str(data.get("unit", "")).strip()
    subfolder = str(data.get("subfolder", "")).strip()
    zone = str(data.get("zone", "")).strip()
    config = data.get("config") or {}

    try:
        count = int(data.get("count", 1))
    except (TypeError, ValueError):
        return jsonify({"error": "count must be a positive integer"}), 400

    if not folder:
        return jsonify({"error": "folder is required"}), 400
    if not prefix:
        return jsonify({"error": "prefix is required"}), 400
    if count <= 0:
        return jsonify({"error": "count must be greater than 0"}), 400
    if model not in MODEL_REGISTRY:
        return jsonify({
            "error": f"Invalid model '{model}'",
            "valid_models": sorted(MODEL_REGISTRY.keys())
        }), 400
    config_error = validate_stateful_config(config)
    if config_error:
        return jsonify({"error": config_error}), 400

    updated_group = {
        "folder": folder,
        "prefix": prefix,
        "model": model,
        "count": count,
    }
    if unit:
        updated_group["unit"] = unit
    if subfolder:
        updated_group["subfolder"] = subfolder
    if zone:
        updated_group["zone"] = zone
    if config:
        updated_group["config"] = config

    old_group = devices[group_index]
    devices[group_index] = updated_group
    profile_json["devices"] = devices

    saved, save_error = save_local_profile_json(current_profile, profile_json)
    if not saved:
        return jsonify({"error": save_error}), 500

    profile_data_cache = None
    write_state(current_profile)

    logger.info(
        f"Updated device group {group_index} in profile '{current_profile}': "
        f"old={old_group} new={updated_group}"
    )

    return jsonify({
        "success": True,
        "profile": current_profile,
        "index": group_index,
        "updated": updated_group,
        "message": "Device group updated and simulator reload triggered"
    })


@app.route('/api/device-groups/<int:group_index>', methods=['DELETE'])
def remove_device_group(group_index):
    """Remove a device group from the active local profile and trigger reload."""
    global profile_data_cache

    state = read_state()
    current_profile = request.args.get("profile") or state.get("profile", "factory")

    profile_json, _, error = load_local_profile_json(current_profile)
    if error:
        return jsonify({"error": error}), 400

    devices = profile_json.get("devices", [])
    if group_index < 0 or group_index >= len(devices):
        return jsonify({"error": f"Device group index {group_index} out of range"}), 404

    removed = devices.pop(group_index)
    profile_json["devices"] = devices

    saved, save_error = save_local_profile_json(current_profile, profile_json)
    if not saved:
        return jsonify({"error": save_error}), 500

    profile_data_cache = None
    write_state(current_profile)

    logger.info(
        f"Removed device group {group_index} from profile '{current_profile}': {removed}"
    )

    return jsonify({
        "success": True,
        "profile": current_profile,
        "index": group_index,
        "removed": removed,
        "message": "Device group removed and simulator reload triggered"
    })


@app.route('/api/device-groups/<int:group_index>/state', methods=['PUT'])
def set_device_group_state(group_index):
    """Set active_state for a device group in the active local profile and trigger reload."""
    global profile_data_cache

    data = request.get_json(silent=True) or {}
    state = read_state()
    current_profile = data.get("profile") or state.get("profile", "factory")
    active_state = str(data.get("active_state", "")).strip()

    if not active_state:
        return jsonify({"error": "active_state is required"}), 400

    profile_json, _, error = load_local_profile_json(current_profile)
    if error:
        return jsonify({"error": error}), 400

    devices = profile_json.get("devices", [])
    if group_index < 0 or group_index >= len(devices):
        return jsonify({"error": f"Device group index {group_index} out of range"}), 404

    group = devices[group_index]
    config = group.get("config")
    if not isinstance(config, dict):
        return jsonify({"error": "Device group config must be an object"}), 400

    states = config.get("states")
    if not isinstance(states, dict) or not states:
        return jsonify({"error": "Device group config.states must be a non-empty object"}), 400

    if active_state not in states:
        return jsonify({
            "error": f"State '{active_state}' not found in group config.states",
            "available_states": sorted(states.keys())
        }), 400

    previous_state = config.get("active_state")
    config["active_state"] = active_state
    group["config"] = config
    devices[group_index] = group
    profile_json["devices"] = devices

    saved, save_error = save_local_profile_json(current_profile, profile_json)
    if not saved:
        return jsonify({"error": save_error}), 500

    profile_data_cache = None
    write_state(current_profile)

    logger.info(
        f"Changed device group {group_index} state in profile '{current_profile}': "
        f"{previous_state} -> {active_state}"
    )

    return jsonify({
        "success": True,
        "profile": current_profile,
        "index": group_index,
        "active_state": active_state,
        "previous_state": previous_state,
        "message": "Device group state updated and simulator reload triggered"
    })

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
