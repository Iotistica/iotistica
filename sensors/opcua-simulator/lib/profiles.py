"""
Sensor profile loading from JSON configuration files
"""
import json
import logging
from pathlib import Path
from typing import List, Dict, Any

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
