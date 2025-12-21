"""
Sensor profiles - define what sensors to create
"""
from typing import Dict, List, Any


class SensorProfile:
    """Definition of sensor groups to create"""
    
    def __init__(self, name: str, sensors: List[Dict[str, Any]]):
        self.name = name
        self.sensors = sensors


# Default factory profile
FACTORY_PROFILE = SensorProfile(
    name="Factory",
    sensors=[
        {
            'folder': 'Temperature',
            'model': 'temperature',
            'prefix': 'Sensor',
            'count': 5,
            'unit': '°C'
        },
        {
            'folder': 'Pressure',
            'model': 'pressure',
            'prefix': 'Sensor',
            'count': 5,
            'unit': 'mbar'
        },
        {
            'folder': 'Flow',
            'model': 'flow',
            'prefix': 'Sensor',
            'count': 5,
            'unit': 'L/min'
        },
        {
            'folder': 'Level',
            'model': 'level',
            'prefix': 'Tank',
            'count': 3,
            'unit': 'mm'
        },
        {
            'folder': 'Vibration',
            'model': 'vibration',
            'prefix': 'Motor',
            'count': 4,
            'unit': 'mm/s'
        },
        {
            'folder': 'Power',
            'model': 'power',
            'prefix': 'Line',
            'count': 3,
            'unit': 'W'
        },
    ]
)


# Simple test profile
TEST_PROFILE = SensorProfile(
    name="Test",
    sensors=[
        {
            'folder': 'Sensors',
            'model': 'temperature',
            'prefix': 'Temp',
            'count': 2,
            'unit': '°C'
        },
        {
            'folder': 'Sensors',
            'model': 'pressure',
            'prefix': 'Pressure',
            'count': 2,
            'unit': 'mbar'
        },
    ]
)


# Profile registry
PROFILES: Dict[str, SensorProfile] = {
    'factory': FACTORY_PROFILE,
    'test': TEST_PROFILE,
}


def get_profile(name: str) -> SensorProfile:
    """Get profile by name"""
    if name not in PROFILES:
        raise ValueError(f"Unknown profile: {name}. Available: {list(PROFILES.keys())}")
    return PROFILES[name]
