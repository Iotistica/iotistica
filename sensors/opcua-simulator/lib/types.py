"""
Type definitions for OPC UA simulator
"""
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class Sensor:
    """
    Structured sensor metadata - eliminates fragile string parsing
    
    Replaces this fragile pattern:
        parts = key.rsplit('_', 1)
        sensor_type = parts[0]
        index = int(parts[1])
    
    With this clean pattern:
        for sensor in self.sensors:
            value = sensor.model.generate(elapsed, sensor.index)
            await sensor.node.write_value(value)
    """
    node: Any                        # ua.Node - using Any to avoid circular import
    sensor_type: str                 # "temperature", "pressure", etc.
    model_type: str                  # Same as sensor_type (for clarity)
    index: int                       # 0, 1, 2, etc. (sensor instance number)
    name: str                        # "Sensor_1", "Motor_3", etc.
    folder: str                      # "Temperature", "Vibration", etc.
    unit: str = ""                   # "°C", "mbar", "L/min", etc.
    min_value: Optional[float] = None  # Minimum value constraint
    max_value: Optional[float] = None  # Maximum value constraint
    config: dict = None              # Sensor-specific config from profile JSON
    model: Any = None                # Cached model instance (set by ValueUpdater)
    
    @property
    def key(self) -> str:
        """Unique key for this sensor"""
        return f"{self.sensor_type}_{self.index}"
