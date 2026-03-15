"""
Device models - mathematical behavior and value generation
"""
import math
import random
from typing import Dict, Any, Callable


class DeviceModel:
    """Base class for device behavior models"""

    @staticmethod
    def _normalize_stateful_config(config: Dict[str, Any], defaults: Dict[str, Any]) -> Dict[str, Any]:
        """
        Enforce and normalize strict behavior-state configuration.

        Required format:
        {
          "active_state": "normal",
          "states": {
            "normal": {...},
            "under_load": {...}
          }
        }
        """
        if not config:
            return {
                'active_state': 'normal',
                'states': {
                    'normal': dict(defaults)
                }
            }

        cfg = dict(config)
        active_state = cfg.get('active_state')
        states = cfg.get('states')

        if not isinstance(active_state, str) or not active_state.strip():
            raise ValueError("Device config requires non-empty 'active_state'")
        if not isinstance(states, dict) or not states:
            raise ValueError("Device config requires non-empty 'states' object")
        if active_state not in states:
            raise ValueError(f"active_state '{active_state}' not found in states")

        normalized_states: Dict[str, Dict[str, Any]] = {}
        for state_name, state_cfg in states.items():
            if not isinstance(state_cfg, dict):
                raise ValueError(f"State '{state_name}' must be an object")
            normalized_states[state_name] = {**defaults, **state_cfg}

        return {
            'active_state': active_state,
            'states': normalized_states
        }
    
    def __init__(self, config: Dict[str, Any]):
        self.config = dict(config or {})

        active_state = self.config.get('active_state')
        states = self.config.get('states')
        if not isinstance(active_state, str) or not active_state.strip():
            raise ValueError("Device config requires non-empty 'active_state'")
        if not isinstance(states, dict) or not states:
            raise ValueError("Device config requires non-empty 'states' object")
        if active_state not in states:
            raise ValueError(f"active_state '{active_state}' not found in states")

        state_cfg = states.get(active_state)
        if not isinstance(state_cfg, dict):
            raise ValueError(f"State '{active_state}' must be an object")

        self.active_state = active_state
        self.effective_config = dict(state_cfg)

        self.base = self.effective_config.get('base', 0.0)
        self.variation = self.effective_config.get('variation', 0.0)
        self.noise = self.effective_config.get('noise', 0.0)

        self.min_value = self.effective_config.get('min_value', None)
        self.max_value = self.effective_config.get('max_value', None)

        # Guard against invalid/non-positive period to avoid division errors.
        period = self.effective_config.get('period', 30.0)
        self.period = period if isinstance(period, (int, float)) and period > 0 else 30.0

        self.spike_probability = self.effective_config.get('spike_probability', 0.0)
        self.spike_magnitude = self.effective_config.get('spike_magnitude', 0.0)
        
    def generate(self, elapsed: float, index: int = 0) -> float:
        """Generate device value at given time"""
        # Sinusoidal variation
        variation = self.variation * math.sin(elapsed / self.period + index * 0.5)
        
        # Random noise
        noise = random.uniform(-self.noise, self.noise)
        
        # Occasional spikes
        spike = 0.0
        if self.spike_probability > 0 and random.random() < self.spike_probability:
            spike = self.spike_magnitude
        
        # Calculate value
        value = self.base + variation + noise + spike
        
        # Apply min/max constraints
        if self.min_value is not None:
            value = max(self.min_value, value)
        if self.max_value is not None:
            value = min(self.max_value, value)
        
        return round(value, 2)


class TemperatureDevice(DeviceModel):
    """Temperature device model (°C)"""
    
    def __init__(self, config: Dict[str, Any] = None):
        defaults = {
            'base': 25.0,
            'variation': 5.0,
            'noise': 0.5,
            'min_value': -50.0,
            'max_value': 150.0,
            'period': 30.0
        }
        normalized = self._normalize_stateful_config(config, defaults)
        super().__init__(normalized)


class PressureDevice(DeviceModel):
    """Pressure device model (mbar)"""
    
    def __init__(self, config: Dict[str, Any] = None):
        defaults = {
            'base': 1100.0,
            'variation': 50.0,
            'noise': 5.0,
            'min_value': 0.0,
            'max_value': 2000.0,
            'period': 45.0
        }
        normalized = self._normalize_stateful_config(config, defaults)
        super().__init__(normalized)


class FlowDevice(DeviceModel):
    """Flow rate device model (L/min)"""
    
    def __init__(self, config: Dict[str, Any] = None):
        defaults = {
            'base': 50.0,
            'variation': 30.0,
            'noise': 2.0,
            'min_value': 0.0,
            'max_value': 100.0,
            'period': 20.0
        }
        normalized = self._normalize_stateful_config(config, defaults)
        super().__init__(normalized)


class LevelDevice(DeviceModel):
    """Level device model (mm)"""
    
    def __init__(self, config: Dict[str, Any] = None):
        defaults = {
            'base': 500.0,
            'variation': 200.0,
            'noise': 10.0,
            'min_value': 0.0,
            'max_value': 1000.0,
            'period': 40.0
        }
        normalized = self._normalize_stateful_config(config, defaults)
        super().__init__(normalized)


class VibrationDevice(DeviceModel):
    """Vibration device model (mm/s)"""
    
    def __init__(self, config: Dict[str, Any] = None):
        defaults = {
            'base': 20.0,
            'variation': 15.0,
            'noise': 2.0,
            'min_value': 0.0,
            'max_value': 100.0,
            'period': 10.0,
            'spike_probability': 0.05,
            'spike_magnitude': 30.0
        }
        normalized = self._normalize_stateful_config(config, defaults)
        super().__init__(normalized)


class PowerDevice(DeviceModel):
    """Power consumption device model (W)"""
    
    def __init__(self, config: Dict[str, Any] = None):
        defaults = {
            'base': 5000.0,
            'variation': 2000.0,
            'noise': 50.0,
            'min_value': 0.0,
            'max_value': 10000.0,
            'period': 25.0
        }
        normalized = self._normalize_stateful_config(config, defaults)
        super().__init__(normalized)


class OscillatingVariable(DeviceModel):
    """Simple oscillating test variable"""
    
    def __init__(self, config: Dict[str, Any] = None):
        defaults = {
            'base': 40.0,
            'variation': 10.0,
            'noise': 0.0,
            'period': 5.0
        }
        normalized = self._normalize_stateful_config(config, defaults)
        super().__init__(normalized)


# Model registry
MODEL_REGISTRY: Dict[str, Callable[[Dict[str, Any]], DeviceModel]] = {
    'temperature': TemperatureDevice,
    'pressure': PressureDevice,
    'flow': FlowDevice,
    'level': LevelDevice,
    'vibration': VibrationDevice,
    'power': PowerDevice,
    'oscillating': OscillatingVariable,
}


def get_model(model_type: str, config: Dict[str, Any] = None) -> DeviceModel:
    """Get device model instance by type with optional config override"""
    if model_type not in MODEL_REGISTRY:
        raise ValueError(f"Unknown model type: {model_type}")
    return MODEL_REGISTRY[model_type](config)
