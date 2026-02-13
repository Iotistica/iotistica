"""
Sensor profile loading from JSON configuration files and API
"""
import json
import logging
import os
from pathlib import Path
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)


class SensorProfile:
    """Defines a collection of sensor groups loaded from JSON"""
    
    def __init__(self, name: str, description: str, sensors: List[Dict[str, Any]]):
        self.name = name
        self.description = description
        self.sensors = sensors
    
    @classmethod
    def from_json(cls, filepath: Path) -> 'SensorProfile':
        """Load profile from JSON file"""
        try:
            with open(filepath, 'r') as f:
                data = json.load(f)
            
            # Validate required fields
            if 'name' not in data:
                raise ValueError(f"Profile missing 'name' field: {filepath}")
            if 'sensors' not in data:
                raise ValueError(f"Profile missing 'sensors' field: {filepath}")
            
            # Validate each sensor group
            for sensor_group in data['sensors']:
                required = {'folder', 'prefix', 'model', 'count'}
                missing = required - set(sensor_group.keys())
                if missing:
                    raise ValueError(f"Sensor group missing fields {missing}: {sensor_group}")
            
            logger.info(f"Loaded profile '{data['name']}' from {filepath.name}")
            
            return cls(
                name=data['name'],
                description=data.get('description', ''),
                sensors=data['sensors']
            )
            
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON in {filepath}: {e}")
        except Exception as e:
            raise ValueError(f"Failed to load profile {filepath}: {e}")


def _get_profiles_dir() -> Path:
    """Get the profiles directory path"""
    # Try profiles/ next to this file first
    lib_dir = Path(__file__).parent
    profiles_dir = lib_dir.parent / 'profiles'
    
    if profiles_dir.exists():
        return profiles_dir
    
    # Fallback to current working directory
    profiles_dir = Path.cwd() / 'profiles'
    if profiles_dir.exists():
        return profiles_dir
    
    raise FileNotFoundError(f"Profiles directory not found. Expected at: {lib_dir.parent / 'profiles'}")


def load_all_profiles() -> Dict[str, SensorProfile]:
    """Load all JSON profiles from profiles directory"""
    profiles = {}
    profiles_dir = _get_profiles_dir()
    
    for json_file in profiles_dir.glob('*.json'):
        try:
            profile = SensorProfile.from_json(json_file)
            # Use filename without .json as key (e.g., factory.json -> factory)
            profile_key = json_file.stem.lower()
            profiles[profile_key] = profile
            
        except Exception as e:
            logger.error(f"Failed to load {json_file.name}: {e}")
    
    if not profiles:
        raise ValueError(f"No valid profiles found in {profiles_dir}")
    
    logger.info(f"Loaded {len(profiles)} profiles: {', '.join(profiles.keys())}")
    return profiles


# Load all profiles at module import
try:
    PROFILES = load_all_profiles()
except Exception as e:
    logger.warning(f"Failed to load profiles: {e}. Using empty registry.")
    PROFILES = {}


def get_profile(name: str) -> SensorProfile:
    """Get profile by name (case-insensitive)"""
    name = name.lower()
    if name not in PROFILES:
        available = ', '.join(PROFILES.keys())
        raise ValueError(f"Unknown profile: {name}. Available: {available}")
    return PROFILES[name]


def list_profiles() -> List[str]:
    """Get list of available profile names"""
    return list(PROFILES.keys())


def load_profile_from_api(profile_name: str, api_url: str) -> SensorProfile:
    """Load profile from API endpoint
    
    API returns format:
    {
        "ProfileName": {
            "dataPoints": [{folder, prefix, model, count, ...}],
            "metadata": {"description": "..."}
        }
    }
    """
    import urllib.request
    import ssl
    import time
    
    # Create SSL context that accepts self-signed certificates
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    
    max_retries = 3
    for attempt in range(max_retries):
        try:
            url = f"{api_url}/api/v1/profiles/datapoints?protocol=opcua"
            req = urllib.request.Request(url, headers={'User-Agent': 'opcua-simulator/2.0'})
            
            with urllib.request.urlopen(req, timeout=5, context=ssl_context) as response:
                all_profiles = json.loads(response.read().decode())
                
                # Find profile (case-insensitive)
                profile_data = None
                for key, value in all_profiles.items():
                    if key.lower() == profile_name.lower():
                        profile_data = value
                        profile_name = key  # Use actual case from API
                        break
                
                if not profile_data:
                    available = ', '.join(all_profiles.keys())
                    raise ValueError(f"Profile '{profile_name}' not found in API. Available: {available}")
                
                # Extract sensors from dataPoints field
                sensors = profile_data.get('dataPoints', [])
                if not sensors:
                    raise ValueError(f"Profile '{profile_name}' has no sensors/dataPoints")
                
                # Extract description from metadata
                metadata = profile_data.get('metadata', {})
                description = metadata.get('description', '')
                
                # Validate sensor groups
                for sensor_group in sensors:
                    required = {'folder', 'prefix', 'model', 'count'}
                    missing = required - set(sensor_group.keys())
                    if missing:
                        raise ValueError(f"Sensor group missing fields {missing}: {sensor_group}")
                
                logger.info(f"Loaded profile '{profile_name}' from API ({len(sensors)} sensor groups)")
                
                return SensorProfile(
                    name=profile_name,
                    description=description,
                    sensors=sensors
                )
                
        except urllib.error.URLError as e:
            if attempt < max_retries - 1:
                logger.warning(f"API attempt {attempt + 1} failed, retrying... {e}")
                time.sleep(1)
            else:
                raise ValueError(f"API failed after {max_retries} attempts: {e}")
        except Exception as e:
            raise ValueError(f"Failed to load profile from API: {e}")


def get_profile_with_api_fallback(name: str, api_url: Optional[str] = None) -> SensorProfile:
    """Get profile - try API first if available, fallback to local JSON
    
    Args:
        name: Profile name to load
        api_url: API base URL (e.g., 'http://api:3002'). If None, uses OPCUA_API_URL env var.
    
    Returns:
        SensorProfile instance
    """
    # Determine API URL
    if api_url is None:
        api_url = os.getenv('OPCUA_API_URL')
    
    # Try API first if URL is provided
    if api_url:
        try:
            return load_profile_from_api(name, api_url)
        except Exception as e:
            logger.warning(f"Failed to load profile '{name}' from API, falling back to local: {e}")
    
    # Fallback to local JSON files
    name_lower = name.lower()
    if name_lower not in PROFILES:
        available_local = ', '.join(PROFILES.keys())
        raise ValueError(f"Profile '{name}' not found locally. Available: {available_local}")
    
    logger.info(f"Using local profile '{name}'")
    return PROFILES[name_lower]
