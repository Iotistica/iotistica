"""
Type definitions for OPC UA simulator
"""
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class Device:
    """
    Structured device metadata - eliminates fragile string parsing
    
    Replaces this fragile pattern:
        parts = key.rsplit('_', 1)
        device_type = parts[0]
        index = int(parts[1])
    
    With this clean pattern:
        for device in self.devices:
            value = device.model.generate(elapsed, device.index)
            await device.node.write_value(value)
    """
    node: Any                        # ua.Node - using Any to avoid circular import
    device_type: str                 # "temperature", "pressure", etc.
    model_type: str                  # Same as device_type (for clarity)
    index: int                       # 0, 1, 2, etc. (device instance number)
    name: str                        # "Device_1", "Motor_3", etc.
    folder: str                      # "Temperature", "Vibration", etc.
    unit: str = ""                   # "°C", "mbar", "L/min", etc.
    min_value: Optional[float] = None  # Minimum value constraint
    max_value: Optional[float] = None  # Maximum value constraint
    config: dict = None              # Device-specific config from profile JSON
    uuid: str = ""                   # Per-device UUID (deterministic, generated at startup via uuid5)
    model: Any = None                # Cached model instance (set by ValueUpdater)
    
    @property
    def key(self) -> str:
        """Unique key for this device"""
        return f"{self.device_type}_{self.index}"
