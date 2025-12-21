"""
Type definitions for OPC UA simulator
"""
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class Sensor:
    """Structured sensor metadata"""
    node: Any  # ua.Node - using Any to avoid circular import
    sensor_type: str
    model_type: str
    index: int
    name: str
    folder: str
    unit: str = ""
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    
    @property
    def key(self) -> str:
        """Unique key for this sensor"""
        return f"{self.sensor_type}_{self.index}"
