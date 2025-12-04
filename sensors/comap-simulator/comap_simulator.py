"""
COMAP Generator Controller Simulator

Simulates a COMAP generator controller with realistic physics,
state machine, and Modbus TCP communication.
"""
import asyncio
import logging
import signal
import sys
import time
from typing import Dict, Any

from pymodbus.server import StartAsyncTcpServer
from pymodbus.datastore import ModbusSlaveContext, ModbusServerContext
from pymodbus.device import ModbusDeviceIdentification

from config import SimulatorConfig
from generator_physics import GeneratorPhysics, GeneratorState
from modbus_data_block import ComapDataBlock, ComapCoilBlock, ComapInputRegisterBlock

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class ComapGeneratorSimulator:
    """Main simulator class managing generator state and Modbus server"""
    
    def __init__(self, config: SimulatorConfig):
        self.config = config
        self.physics = GeneratorPhysics(
            rated_kw=config.rated_kw,
            rated_voltage=config.rated_voltage,
            fuel_tank_l=config.fuel_tank_l,
            noise_percent=config.noise_percent
        )
        
        # Generator state
        self.state = GeneratorState.OFF
        self.state_time = 0.0  # Time in current state
        self.run_hours = 0.0
        
        # Current values
        self.engine_rpm = 0.0
        self.gen_voltage_a = 0.0
        self.gen_voltage_b = 0.0
        self.gen_voltage_c = 0.0
        self.gen_current_a = 0.0
        self.gen_current_b = 0.0
        self.gen_current_c = 0.0
        self.frequency = 0.0
        self.power_kw = 0.0
        self.engine_temp = self.physics.ambient_temp
        self.fuel_level = 100.0
        self.oil_pressure = 0.0
        self.battery_voltage = 24.0
        self.power_factor = self.physics.power_factor
        
        # Additional metrics
        self.exhaust_temp = 0.0
        self.intake_temp = self.physics.ambient_temp
        self.fuel_rate = 0.0
        
        # Alarm states
        self.alarm_overspeed = False
        self.alarm_low_oil = False
        self.alarm_high_temp = False
        self.alarm_overload = False
        
        # State transition parameters
        self.startup_ramp_time = 15.0  # seconds
        self.cooldown_time = 60.0  # seconds
        self.last_update_time = time.time()
        self.next_state_change = time.time() + config.state_change_interval
        
        # Shared state dictionary for data blocks
        self.state_dict = {}
        self.update_state_dict()
        
        logger.info(f"COMAP Simulator initialized: {config}")
    
    def update_state_dict(self):
        """Update shared state dictionary for Modbus data blocks"""
        self.state_dict.update({
            'engine_rpm': self.engine_rpm,
            'gen_voltage_a': self.gen_voltage_a,
            'gen_voltage_b': self.gen_voltage_b,
            'gen_voltage_c': self.gen_voltage_c,
            'gen_current_a': self.gen_current_a,
            'gen_current_b': self.gen_current_b,
            'gen_current_c': self.gen_current_c,
            'frequency': self.frequency,
            'power_kw': self.power_kw,
            'engine_temp': self.engine_temp,
            'fuel_level': self.fuel_level,
            'oil_pressure': self.oil_pressure,
            'battery_voltage': self.battery_voltage,
            'run_hours_low': int(self.run_hours) & 0xFFFF,
            'run_hours_high': (int(self.run_hours) >> 16) & 0xFFFF,
            'power_factor': self.power_factor,
            'exhaust_temp': self.exhaust_temp,
            'intake_temp': self.intake_temp,
            'fuel_rate': self.fuel_rate,
            'alarm_overspeed': self.alarm_overspeed,
            'alarm_low_oil': self.alarm_low_oil,
            'alarm_high_temp': self.alarm_high_temp,
            'alarm_overload': self.alarm_overload,
        })
    
    def update_state(self):
        """Update generator state based on current state and elapsed time"""
        current_time = time.time()
        time_step = current_time - self.last_update_time
        self.last_update_time = current_time
        self.state_time += time_step
        
        if self.state == GeneratorState.OFF:
            self._update_off_state()
        elif self.state == GeneratorState.STARTING:
            self._update_starting_state(time_step)
        elif self.state == GeneratorState.RUNNING:
            self._update_running_state(time_step)
        elif self.state == GeneratorState.COOLING:
            self._update_cooling_state(time_step)
        elif self.state == GeneratorState.FAULT:
            self._update_fault_state()
        
        # Check for alarms
        self._check_alarms()
        
        # Check for automatic state transitions
        self._check_state_transitions(current_time)
        
        # Update shared state dictionary
        self.update_state_dict()
    
    def _update_off_state(self):
        """Update values when generator is OFF"""
        self.engine_rpm = 0.0
        self.gen_voltage_a = 0.0
        self.gen_voltage_b = 0.0
        self.gen_voltage_c = 0.0
        self.gen_current_a = 0.0
        self.gen_current_b = 0.0
        self.gen_current_c = 0.0
        self.frequency = 0.0
        self.power_kw = 0.0
        self.oil_pressure = 0.0
        self.battery_voltage = self.physics.apply_noise(24.0)
        self.exhaust_temp = self.physics.ambient_temp
        self.fuel_rate = 0.0
        
        # Temperature decays to ambient
        if self.engine_temp > self.physics.ambient_temp:
            self.engine_temp = max(self.physics.ambient_temp, self.engine_temp - 0.5)
    
    def _update_starting_state(self, time_step: float):
        """Update values during generator startup"""
        # Ramp RPM from 0 to 1800 over startup_ramp_time
        target_rpm = self.physics.nominal_rpm
        self.engine_rpm = self.physics.ramp_value(0, target_rpm, self.state_time, self.startup_ramp_time)
        
        # Frequency follows RPM
        self.frequency = self.physics.rpm_to_frequency(self.engine_rpm)
        
        # Voltage ramps up following RPM
        target_voltage = self.config.rated_voltage
        ramp_voltage = self.physics.ramp_value(0, target_voltage, self.state_time, self.startup_ramp_time)
        self.gen_voltage_a = ramp_voltage
        self.gen_voltage_b = ramp_voltage * 0.99  # Slight imbalance
        self.gen_voltage_c = ramp_voltage * 1.01
        
        # No load during startup
        self.gen_current_a = 0.0
        self.gen_current_b = 0.0
        self.gen_current_c = 0.0
        self.power_kw = 0.0
        
        # Oil pressure ramps up
        self.oil_pressure = self.physics.calculate_oil_pressure(self.engine_rpm, True)
        
        # Battery voltage drops during crank, then recovers
        if self.state_time < 3.0:
            self.battery_voltage = 22.0
        else:
            self.battery_voltage = self.physics.ramp_value(22.0, 26.0, self.state_time - 3.0, 5.0)
        
        # Temperature rises slowly
        self.engine_temp = self.physics.calculate_temperature(self.engine_temp, 0, time_step)
        self.exhaust_temp = self.physics.ambient_temp + (self.state_time * 10)
        
        # Transition to RUNNING when RPM and voltage are stable
        if self.state_time >= self.startup_ramp_time and self.engine_rpm > 1700:
            logger.info("Generator startup complete - transitioning to RUNNING")
            self.transition_to_state(GeneratorState.RUNNING)
    
    def _update_running_state(self, time_step: float):
        """Update values during normal running operation"""
        # Steady-state RPM with noise
        self.engine_rpm = self.physics.apply_noise(self.physics.nominal_rpm)
        self.frequency = self.physics.rpm_to_frequency(self.engine_rpm)
        
        # Simulate load (varies between 50-75% for realistic operation)
        load_percent = 50 + 25 * (0.5 + 0.5 * (time.time() % 60) / 60)
        self.power_kw = (load_percent / 100) * self.config.rated_kw
        
        # Calculate voltage with regulation
        voltages = self.physics.calculate_3phase_voltages(self.config.rated_voltage, load_percent)
        self.gen_voltage_a = self.physics.apply_noise(voltages[0])
        self.gen_voltage_b = self.physics.apply_noise(voltages[1])
        self.gen_voltage_c = self.physics.apply_noise(voltages[2])
        
        # Calculate 3-phase currents
        currents = self.physics.calculate_3phase_currents(self.power_kw, self.config.rated_voltage)
        self.gen_current_a = self.physics.apply_noise(currents[0])
        self.gen_current_b = self.physics.apply_noise(currents[1])
        self.gen_current_c = self.physics.apply_noise(currents[2])
        
        # Temperature based on load
        self.engine_temp = self.physics.calculate_temperature(self.engine_temp, load_percent, time_step)
        self.exhaust_temp = self.engine_temp + 200  # Exhaust is hotter
        
        # Oil pressure
        self.oil_pressure = self.physics.apply_noise(self.physics.calculate_oil_pressure(self.engine_rpm, True))
        
        # Battery voltage (charging)
        self.battery_voltage = self.physics.apply_noise(27.0)
        
        # Fuel consumption
        self.fuel_rate = self.physics.calculate_fuel_consumption(self.power_kw)
        self.fuel_level = self.physics.calculate_fuel_level(self.fuel_level, self.fuel_rate, time_step)
        
        # Accumulate run hours
        self.run_hours += time_step / 3600.0
    
    def _update_cooling_state(self, time_step: float):
        """Update values during cooldown"""
        # Reduced idle RPM
        self.engine_rpm = self.physics.apply_noise(1200)
        self.frequency = self.physics.rpm_to_frequency(self.engine_rpm)
        
        # Reduced voltage
        self.gen_voltage_a = self.physics.apply_noise(230)
        self.gen_voltage_b = self.physics.apply_noise(228)
        self.gen_voltage_c = self.physics.apply_noise(232)
        
        # No load
        self.gen_current_a = 0.0
        self.gen_current_b = 0.0
        self.gen_current_c = 0.0
        self.power_kw = 0.0
        
        # Temperature declining
        self.engine_temp = self.physics.calculate_temperature(self.engine_temp, 0, time_step)
        self.exhaust_temp = self.engine_temp + 50
        
        # Oil pressure at idle
        self.oil_pressure = self.physics.apply_noise(40.0)
        
        # Battery voltage
        self.battery_voltage = self.physics.apply_noise(27.0)
        
        # Minimal fuel consumption
        self.fuel_rate = self.physics.calculate_fuel_consumption(0)
        
        # Transition to OFF after cooldown
        if self.state_time >= self.cooldown_time:
            logger.info("Cooldown complete - transitioning to OFF")
            self.transition_to_state(GeneratorState.OFF)
    
    def _update_fault_state(self):
        """Update values during fault condition"""
        # Maintain last values, but may shut down for critical faults
        if self.alarm_low_oil:
            # Emergency shutdown for low oil
            self.engine_rpm = 0.0
            self.frequency = 0.0
            self.gen_voltage_a = 0.0
            self.gen_voltage_b = 0.0
            self.gen_voltage_c = 0.0
    
    def _check_alarms(self):
        """Check for alarm conditions"""
        # Overspeed alarm
        self.alarm_overspeed = self.engine_rpm > 2000 or self.config.inject_overspeed
        
        # Low oil pressure alarm
        self.alarm_low_oil = (self.oil_pressure < 20 and self.engine_rpm > 800) or self.config.inject_low_oil
        
        # High temperature alarm
        self.alarm_high_temp = self.engine_temp > 105 or self.config.inject_high_temp
        
        # Overload alarm
        self.alarm_overload = self.power_kw > (self.config.rated_kw * 1.1) or self.config.inject_overload
        
        # Transition to FAULT if any alarm is active
        any_alarm = self.alarm_overspeed or self.alarm_low_oil or self.alarm_high_temp or self.alarm_overload
        if any_alarm and self.state != GeneratorState.FAULT:
            logger.warning(f"Alarm triggered - transitioning to FAULT state")
            self.transition_to_state(GeneratorState.FAULT)
    
    def _check_state_transitions(self, current_time: float):
        """Check for automatic state transitions"""
        # Auto-start if configured
        if self.config.auto_start and self.state == GeneratorState.OFF and self.state_time > 5.0:
            logger.info("Auto-start enabled - transitioning to STARTING")
            self.transition_to_state(GeneratorState.STARTING)
        
        # Periodic state changes for demo
        if current_time >= self.next_state_change:
            self.next_state_change = current_time + self.config.state_change_interval
            
            if self.state == GeneratorState.RUNNING:
                logger.info("Periodic state change - transitioning to COOLING")
                self.transition_to_state(GeneratorState.COOLING)
            elif self.state == GeneratorState.OFF:
                logger.info("Periodic state change - transitioning to STARTING")
                self.transition_to_state(GeneratorState.STARTING)
    
    def transition_to_state(self, new_state: GeneratorState):
        """Transition to a new generator state"""
        logger.info(f"State transition: {self.state.value} -> {new_state.value}")
        self.state = new_state
        self.state_time = 0.0


async def run_simulator(config: SimulatorConfig):
    """Run the COMAP generator simulator"""
    logger.info("Starting COMAP Generator Simulator")
    logger.info(f"Configuration: {config}")
    
    # Create simulator instance
    simulator = ComapGeneratorSimulator(config)
    
    # Create Modbus data blocks with shared state
    holding_block = ComapDataBlock(0, simulator.state_dict)
    coil_block = ComapCoilBlock(0, simulator.state_dict)
    input_block = ComapInputRegisterBlock(0, simulator.state_dict)
    
    # Create slave contexts for each slave ID
    slaves = {}
    for i in range(config.modbus_slaves):
        slave_id = config.modbus_slave_start + i
        slaves[slave_id] = ModbusSlaveContext(
            di=None,  # Discrete inputs not used
            co=coil_block,  # Coils (alarm states)
            hr=holding_block,  # Holding registers (main telemetry)
            ir=input_block  # Input registers (additional metrics)
        )
        logger.info(f"Created Modbus slave context for ID {slave_id}")
    
    # Create server context
    context = ModbusServerContext(slaves=slaves, single=False)
    
    # Device identification
    identity = ModbusDeviceIdentification()
    identity.VendorName = 'COMAP'
    identity.ProductCode = 'IGEN-NT'
    identity.VendorUrl = 'https://www.comap-control.com'
    identity.ProductName = 'InteliGen NT Controller (Simulated)'
    identity.ModelName = 'IGEN-NT-100'
    identity.MajorMinorRevision = '1.0.0'
    
    # Background task to update generator state
    async def update_loop():
        while True:
            simulator.update_state()
            await asyncio.sleep(1.0)  # Update every second
    
    # Start update loop
    asyncio.create_task(update_loop())
    
    # Start Modbus TCP server
    logger.info(f"Starting Modbus TCP server on port {config.modbus_port}")
    await StartAsyncTcpServer(
        context=context,
        identity=identity,
        address=("0.0.0.0", config.modbus_port)
    )


def main():
    """Main entry point"""
    # Load configuration
    config = SimulatorConfig()
    
    # Handle shutdown gracefully
    def signal_handler(sig, frame):
        logger.info("Shutdown signal received, stopping simulator...")
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Run simulator
    try:
        asyncio.run(run_simulator(config))
    except KeyboardInterrupt:
        logger.info("Simulator stopped by user")
    except Exception as e:
        logger.error(f"Simulator error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
