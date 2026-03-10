"""
OPC UA Simulator - Modular architecture
"""
from .server import OPCUASimulator, main
from .models import get_model, MODEL_REGISTRY
from .profiles import get_profile, get_profile_with_api_fallback, PROFILES
from .nodes import NodeManager
from .updater import ValueUpdater

__version__ = "2.0.0"
__all__ = [
    'OPCUASimulator',
    'main',
    'get_model',
    'get_profile',
    'get_profile_with_api_fallback',
    'NodeManager',
    'ValueUpdater',
    'MODEL_REGISTRY',
    'PROFILES',
]
