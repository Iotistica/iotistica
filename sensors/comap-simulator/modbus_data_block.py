"""
Modbus data block for COMAP generator registers
"""
from pymodbus.datastore import ModbusSequentialDataBlock
from typing import Optional
import logging

logger = logging.getLogger(__name__)


class ComapDataBlock(ModbusSequentialDataBlock):
    """Custom data block that provides dynamic register values from generator"""
    
    def __init__(self, address: int, generator_state: dict):
        """
        Initialize data block with generator state reference
        
        Args:
            address: Starting register address
            generator_state: Reference to generator state dictionary
        """
        # Initialize with zeros - values will be provided dynamically
        values = [0] * 300  # Allocate space for registers 0-299
        super().__init__(address, values)
        self.generator_state = generator_state
        
        # Register map: address -> state key
        self.holding_register_map = {
            100: 'engine_rpm',
            110: 'gen_voltage_a',
            111: 'gen_voltage_b',
            112: 'gen_voltage_c',
            120: 'gen_current_a',
            121: 'gen_current_b',
            122: 'gen_current_c',
            130: 'frequency',
            140: 'power_kw',
            150: 'engine_temp',
            160: 'fuel_level',
            170: 'oil_pressure',
            180: 'battery_voltage',
            190: 'run_hours_low',  # Lower 16 bits
            191: 'run_hours_high',  # Upper 16 bits
            200: 'power_factor',
        }
        
        self.input_register_map = {
            0: 'exhaust_temp',
            1: 'intake_temp',
            2: 'fuel_rate',
        }
    
    def getValues(self, address: int, count: int = 1) -> list:
        """
        Get register values from generator state
        
        Args:
            address: Starting register address
            count: Number of registers to read
            
        Returns:
            List of register values
        """
        values = []
        
        for i in range(count):
            reg_addr = address + i
            
            # Look up value from generator state
            if reg_addr in self.holding_register_map:
                key = self.holding_register_map[reg_addr]
                value = self.generator_state.get(key, 0)
                
                # Apply scaling if needed
                if key in ['gen_current_a', 'gen_current_b', 'gen_current_c']:
                    # Current in 0.1A resolution
                    value = int(value * 10)
                elif key == 'frequency':
                    # Frequency in 0.01 Hz resolution
                    value = int(value * 100)
                elif key == 'oil_pressure':
                    # Oil pressure in 0.1 psi resolution
                    value = int(value * 10)
                elif key == 'battery_voltage':
                    # Battery voltage in 0.1V resolution
                    value = int(value * 10)
                elif key == 'power_factor':
                    # Power factor in 0.001 resolution
                    value = int(value * 1000)
                else:
                    # Most values are already integers
                    value = int(value)
                
                values.append(value)
            else:
                # Register not mapped, return 0
                values.append(0)
        
        return values


class ComapCoilBlock(ModbusSequentialDataBlock):
    """Coil data block for alarm states"""
    
    def __init__(self, address: int, generator_state: dict):
        """
        Initialize coil block with generator state reference
        
        Args:
            address: Starting coil address
            generator_state: Reference to generator state dictionary
        """
        values = [False] * 16  # Allocate space for coils 0-15
        super().__init__(address, values)
        self.generator_state = generator_state
        
        # Coil map: address -> state key
        self.coil_map = {
            0: 'alarm_overspeed',
            1: 'alarm_low_oil',
            2: 'alarm_high_temp',
            3: 'alarm_overload',
        }
    
    def getValues(self, address: int, count: int = 1) -> list:
        """
        Get coil values from generator state
        
        Args:
            address: Starting coil address
            count: Number of coils to read
            
        Returns:
            List of boolean coil values
        """
        values = []
        
        for i in range(count):
            coil_addr = address + i
            
            if coil_addr in self.coil_map:
                key = self.coil_map[coil_addr]
                value = self.generator_state.get(key, False)
                values.append(bool(value))
            else:
                values.append(False)
        
        return values


class ComapInputRegisterBlock(ModbusSequentialDataBlock):
    """Input register data block for additional metrics"""
    
    def __init__(self, address: int, generator_state: dict):
        """
        Initialize input register block with generator state reference
        
        Args:
            address: Starting register address
            generator_state: Reference to generator state dictionary
        """
        values = [0] * 16  # Allocate space for input registers 0-15
        super().__init__(address, values)
        self.generator_state = generator_state
        
        # Input register map: address -> state key
        self.input_map = {
            0: 'exhaust_temp',
            1: 'intake_temp',
            2: 'fuel_rate',
        }
    
    def getValues(self, address: int, count: int = 1) -> list:
        """
        Get input register values from generator state
        
        Args:
            address: Starting register address
            count: Number of registers to read
            
        Returns:
            List of register values
        """
        values = []
        
        for i in range(count):
            reg_addr = address + i
            
            if reg_addr in self.input_map:
                key = self.input_map[reg_addr]
                value = self.generator_state.get(key, 0)
                
                # Apply scaling if needed
                if key == 'fuel_rate':
                    # Fuel rate in 0.1 L/hr resolution
                    value = int(value * 10)
                else:
                    value = int(value)
                
                values.append(value)
            else:
                values.append(0)
        
        return values
