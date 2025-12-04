"""
Generator physics calculations and correlations
"""
import math
import random
from enum import Enum
from typing import Tuple


class GeneratorState(Enum):
    """Generator operational states"""
    OFF = "OFF"
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    COOLING = "COOLING"
    FAULT = "FAULT"


class GeneratorPhysics:
    """Calculate realistic generator parameters based on physics"""
    
    def __init__(self, rated_kw: int = 100, rated_voltage: int = 240, 
                 fuel_tank_l: int = 200, noise_percent: float = 1.0):
        self.rated_kw = rated_kw
        self.rated_voltage = rated_voltage
        self.fuel_tank_l = fuel_tank_l
        self.noise_percent = noise_percent
        
        # Generator constants
        self.poles = 2  # 2-pole synchronous generator
        self.nominal_rpm = 1800  # RPM at 60Hz
        self.nominal_frequency = 60.0  # Hz
        self.power_factor = 0.85  # Typical lagging PF
        
        # Thermal constants
        self.ambient_temp = 25.0  # °C
        self.thermal_time_constant = 180.0  # seconds (3 minutes)
        
    def rpm_to_frequency(self, rpm: float) -> float:
        """Convert engine RPM to electrical frequency"""
        # f = (RPM × poles) / 120
        return (rpm * self.poles) / 120.0
    
    def frequency_to_rpm(self, frequency: float) -> float:
        """Convert electrical frequency to engine RPM"""
        # RPM = (f × 120) / poles
        return (frequency * 120.0) / self.poles
    
    def calculate_current_per_phase(self, power_kw: float, voltage_ll: float) -> float:
        """Calculate current per phase for 3-phase power"""
        # I = P / (√3 × V × PF)
        if voltage_ll <= 0:
            return 0.0
        power_w = power_kw * 1000
        current = power_w / (math.sqrt(3) * voltage_ll * self.power_factor)
        return current
    
    def calculate_3phase_currents(self, power_kw: float, voltage_ll: float) -> Tuple[float, float, float]:
        """Calculate 3-phase currents with realistic imbalance"""
        base_current = self.calculate_current_per_phase(power_kw, voltage_ll)
        
        # Introduce realistic phase imbalance (±2-5%)
        current_a = base_current
        current_b = base_current * random.uniform(0.97, 1.03)
        current_c = base_current * random.uniform(0.97, 1.03)
        
        return current_a, current_b, current_c
    
    def calculate_voltage_under_load(self, base_voltage: float, load_percent: float) -> float:
        """Calculate voltage drop under load (2-3% per 25% load)"""
        voltage_drop_factor = 1 - (load_percent / 100 * 0.0003)
        return base_voltage * voltage_drop_factor
    
    def calculate_3phase_voltages(self, base_voltage: float, load_percent: float) -> Tuple[float, float, float]:
        """Calculate 3-phase voltages with regulation and balance"""
        voltage_regulated = self.calculate_voltage_under_load(base_voltage, load_percent)
        
        # Introduce realistic phase imbalance (±1-3%)
        voltage_a = voltage_regulated
        voltage_b = voltage_regulated * random.uniform(0.98, 1.02)
        voltage_c = voltage_regulated * random.uniform(0.98, 1.02)
        
        return voltage_a, voltage_b, voltage_c
    
    def calculate_temperature(self, current_temp: float, load_percent: float, 
                             time_step: float) -> float:
        """Calculate engine temperature with thermal model"""
        # Steady-state temperature based on load
        temp_ss = self.ambient_temp + (load_percent * 0.7)
        
        # First-order thermal response: T(t) = T_ss + (T_0 - T_ss) * e^(-t/τ)
        # Simplified: dT/dt = (T_ss - T_current) / τ
        temp_rise_rate = (temp_ss - current_temp) / self.thermal_time_constant
        new_temp = current_temp + (temp_rise_rate * time_step)
        
        return new_temp
    
    def calculate_fuel_consumption(self, power_kw: float) -> float:
        """Calculate fuel consumption rate in L/hr"""
        # Diesel: ~0.3 L/kWh at rated load
        fuel_rate_lph = power_kw * 0.3
        return fuel_rate_lph
    
    def calculate_fuel_level(self, current_level: float, fuel_rate_lph: float, 
                            time_step: float) -> float:
        """Calculate fuel level percentage"""
        fuel_consumed_l = fuel_rate_lph * (time_step / 3600.0)
        fuel_consumed_percent = (fuel_consumed_l / self.fuel_tank_l) * 100
        new_level = max(0, current_level - fuel_consumed_percent)
        return new_level
    
    def calculate_oil_pressure(self, rpm: float, running: bool) -> float:
        """Calculate engine oil pressure based on RPM"""
        if not running or rpm < 500:
            return 0.0
        
        # Oil pressure proportional to RPM (40-70 psi range)
        base_pressure = 40 + (rpm / 1800 * 30)
        return min(70, base_pressure)
    
    def apply_noise(self, value: float) -> float:
        """Apply random noise to a value"""
        if self.noise_percent <= 0:
            return value
        
        noise_factor = 1 + random.uniform(-self.noise_percent / 100, self.noise_percent / 100)
        return value * noise_factor
    
    def ramp_value(self, current: float, target: float, time_elapsed: float, 
                   total_time: float) -> float:
        """Linearly ramp a value from current to target over time"""
        if time_elapsed >= total_time:
            return target
        
        progress = time_elapsed / total_time
        return current + (target - current) * progress
