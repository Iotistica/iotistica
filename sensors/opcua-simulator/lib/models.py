"""
Sensor models - mathematical behavior and value generation
"""
import math
import random
import time
from typing import Dict, Any, Callable


class SensorModel:
    """Base class for sensor behavior models"""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.base = config.get('base', 0.0)
        self.variation = config.get('variation', 0.0)
        self.noise = config.get('noise', 0.0)
        self.min_value = config.get('min', None)
        self.max_value = config.get('max', None)
        self.period = config.get('period', 30.0)  # seconds for one cycle
        self.spike_probability = config.get('spike_probability', 0.0)
        self.spike_magnitude = config.get('spike_magnitude', 0.0)
        
    def generate(self, elapsed: float, index: int = 0) -> float:
        """Generate sensor value at given time"""
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


class TemperatureSensor(SensorModel):
    """Temperature sensor model (°C)"""
    
    def __init__(self):
        super().__init__({
            'base': 25.0,
            'variation': 5.0,
            'noise': 0.5,
            'min': -50.0,
            'max': 150.0,
            'period': 30.0
        })


class PressureSensor(SensorModel):
    """Pressure sensor model (mbar)"""
    
    def __init__(self):
        super().__init__({
            'base': 1100.0,
            'variation': 50.0,
            'noise': 5.0,
            'min': 0.0,
            'max': 2000.0,
            'period': 45.0
        })


class FlowSensor(SensorModel):
    """Flow rate sensor model (L/min)"""
    
    def __init__(self):
        super().__init__({
            'base': 50.0,
            'variation': 30.0,
            'noise': 2.0,
            'min': 0.0,
            'max': 100.0,
            'period': 20.0
        })


class LevelSensor(SensorModel):
    """Level sensor model (mm)"""
    
    def __init__(self):
        super().__init__({
            'base': 500.0,
            'variation': 200.0,
            'noise': 10.0,
            'min': 0.0,
            'max': 1000.0,
            'period': 40.0
        })


class VibrationSensor(SensorModel):
    """Vibration sensor model (mm/s)"""
    
    def __init__(self):
        super().__init__({
            'base': 20.0,
            'variation': 15.0,
            'noise': 2.0,
            'min': 0.0,
            'max': 100.0,
            'period': 10.0,
            'spike_probability': 0.05,
            'spike_magnitude': 30.0
        })


class PowerSensor(SensorModel):
    """Power consumption sensor model (W)"""
    
    def __init__(self):
        super().__init__({
            'base': 5000.0,
            'variation': 2000.0,
            'noise': 50.0,
            'min': 0.0,
            'max': 10000.0,
            'period': 25.0
        })


class OscillatingVariable(SensorModel):
    """Simple oscillating test variable"""
    
    def __init__(self):
        super().__init__({
            'base': 40.0,
            'variation': 10.0,
            'noise': 0.0,
            'period': 5.0
        })


# Model registry
MODEL_REGISTRY: Dict[str, Callable[[], SensorModel]] = {
    'temperature': TemperatureSensor,
    'pressure': PressureSensor,
    'flow': FlowSensor,
    'level': LevelSensor,
    'vibration': VibrationSensor,
    'power': PowerSensor,
    'oscillating': OscillatingVariable,
}


def get_model(model_type: str) -> SensorModel:
    """Get sensor model instance by type"""
    if model_type not in MODEL_REGISTRY:
        raise ValueError(f"Unknown model type: {model_type}")
    return MODEL_REGISTRY[model_type]()
