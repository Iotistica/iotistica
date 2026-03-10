"""
Configuration loader for COMAP Generator Simulator
"""
import os
from typing import Dict, Any


class SimulatorConfig:
    """Load and validate simulator configuration from environment variables"""
    
    def __init__(self):
        self.modbus_port = int(os.getenv('MODBUS_PORT', '502'))
        self.modbus_slaves = int(os.getenv('MODBUS_SLAVES', '3'))
        self.modbus_slave_start = int(os.getenv('MODBUS_SLAVE_START', '1'))
        
        # Generator specifications
        self.rated_kw = int(os.getenv('GENERATOR_RATED_KW', '100'))
        self.rated_voltage = int(os.getenv('GENERATOR_RATED_VOLTAGE', '240'))
        self.fuel_tank_l = int(os.getenv('GENERATOR_FUEL_TANK_L', '200'))
        
        # Operational parameters
        self.auto_start = os.getenv('AUTO_START', 'false').lower() == 'true'
        self.state_change_interval = int(os.getenv('STATE_CHANGE_INTERVAL', '300'))
        self.noise_percent = float(os.getenv('NOISE_PERCENT', '1.0'))
        
        # Fault injection
        self.inject_overspeed = os.getenv('INJECT_OVERSPEED', 'false').lower() == 'true'
        self.inject_low_oil = os.getenv('INJECT_LOW_OIL', 'false').lower() == 'true'
        self.inject_high_temp = os.getenv('INJECT_HIGH_TEMP', 'false').lower() == 'true'
        self.inject_overload = os.getenv('INJECT_OVERLOAD', 'false').lower() == 'true'
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert config to dictionary"""
        return {
            'modbus_port': self.modbus_port,
            'modbus_slaves': self.modbus_slaves,
            'modbus_slave_start': self.modbus_slave_start,
            'rated_kw': self.rated_kw,
            'rated_voltage': self.rated_voltage,
            'fuel_tank_l': self.fuel_tank_l,
            'auto_start': self.auto_start,
            'state_change_interval': self.state_change_interval,
            'noise_percent': self.noise_percent,
            'inject_overspeed': self.inject_overspeed,
            'inject_low_oil': self.inject_low_oil,
            'inject_high_temp': self.inject_high_temp,
            'inject_overload': self.inject_overload,
        }
    
    def __repr__(self) -> str:
        return f"SimulatorConfig({self.to_dict()})"
