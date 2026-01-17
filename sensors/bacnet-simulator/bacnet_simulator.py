import asyncio
import random
import math
import os
import socket
from datetime import datetime
from bacpypes3.local.device import DeviceObject
from bacpypes3.local.analog import AnalogInputObject
from bacpypes3.local.binary import BinaryInputObject
from bacpypes3.app import Application
from bacpypes3.primitivedata import Real, Enumerated
from bacpypes3.pdu import Address
from bacpypes3.debugging import bacpypes_debugging, ModuleLogger

# Enable debug logging
_debug = 1
_log = ModuleLogger(globals())

# Custom Application that responds to Who-Is requests
@bacpypes_debugging
class ResponsiveApplication(Application):
    """BACnet application that explicitly handles Who-Is requests"""
    
    def indication(self, apdu):
        """Log all incoming packets for debugging"""
        if _debug:
            _log.debug(f"[BACnet] Received packet: {apdu.__class__.__name__} from {apdu.pduSource}")
        
        # Call parent to handle normally
        super().indication(apdu)
    
    def do_WhoIsRequest(self, apdu):
        """Handle incoming Who-Is request and respond with I-Am"""
        if _debug:
            _log.debug(f"[BACnet] Processing Who-Is from {apdu.pduSource}")
        
        print(f"[BACnet] Received Who-Is request from {apdu.pduSource}")
        
        # Check if request is for our device ID or broadcast
        device_id = self.device_object.objectIdentifier[1]
        low_limit = apdu.deviceInstanceRangeLowLimit
        high_limit = apdu.deviceInstanceRangeHighLimit
        
        # Respond if:
        # 1. No range specified (broadcast Who-Is)
        # 2. Our device ID is within the specified range
        should_respond = (
            (low_limit is None and high_limit is None) or
            (low_limit is not None and high_limit is not None and low_limit <= device_id <= high_limit)
        )
        
        if should_respond:
            print(f"[BACnet] Sending I-Am response (device {device_id})")
            self.i_am()
        else:
            print(f"[BACnet] Device {device_id} not in range {low_limit}-{high_limit}, ignoring")

# Single BACnet device with all building points
class CondoSimulator:
    def __init__(self):
        self.app = None
        self.device = None
        self.points = {}
        
        self.time_of_day = 12.0
        self.outdoor_temp = 25.0
        self.start_time = datetime.now()
        
    async def initialize(self):
        """Initialize BACnet device with all points"""
        print("\nInitializing BACnet device...")
        
        # Get bind address from environment variable or auto-detect
        bind_addr = os.environ.get('BACPYPES_IFACE', None)
        
        if bind_addr:
            print(f"✓ Using BACPYPES_IFACE from environment: {bind_addr}")
        else:
            # Auto-detect: try to get host IP
            try:
                hostname = socket.gethostname()
                container_ip = socket.gethostbyname(hostname)
                if container_ip and container_ip != '127.0.0.1':
                    bind_addr = f"{container_ip}:47808"
                    print(f"✓ Auto-detected IP: {container_ip}")
                else:
                    bind_addr = "0.0.0.0:47808"
            except:
                bind_addr = "0.0.0.0:47808"
        
        print(f"✓ Binding to: {bind_addr}")
        
        # Create device object first
        self.device = DeviceObject(
            objectIdentifier="device,1001",
            objectName="Condo-Building-1",
            vendorIdentifier=999,
        )
        
        # Create custom application that handles Who-Is requests
        self.app = ResponsiveApplication(
            self.device,
            Address(bind_addr)
        )
        
        # Wait for async initialization
        await asyncio.sleep(0.1)
        
        print(f"✓ BACnet listener ready on {bind_addr}/udp")
        print(f"✓ Created device 'Condo-Building-1' (device ID: 1001)")
        
        # Send initial I-Am announcement
        self.app.i_am()
        print(f"✓ Sent I-Am announcement (Who-Is handler active)")


        
        # Chiller points
        self.points['chiller_status'] = BinaryInputObject(
            objectIdentifier="binary-input,1",
            objectName="Chiller-1 Status",
            presentValue=Enumerated(1)
        )
        self.app.add_object(self.points['chiller_status'])
        
        self.points['chiller_supply_temp'] = AnalogInputObject(
            objectIdentifier="analog-input,2",
            objectName="Chiller-1 Supply Temp",
            presentValue=Real(7.0)
        )
        self.app.add_object(self.points['chiller_supply_temp'])
        
        self.points['chiller_return_temp'] = AnalogInputObject(
            objectIdentifier="analog-input,3",
            objectName="Chiller-1 Return Temp",
            presentValue=Real(12.0)
        )
        self.app.add_object(self.points['chiller_return_temp'])
        
        self.points['chiller_power'] = AnalogInputObject(
            objectIdentifier="analog-input,4",
            objectName="Chiller-1 Power",
            presentValue=Real(85.0)
        )
        self.app.add_object(self.points['chiller_power'])
        
        # AHU-1 points
        self.points['ahu1_supply_temp'] = AnalogInputObject(
            objectIdentifier="analog-input,10",
            objectName="AHU-1 Supply Temp",
            presentValue=Real(18.0)
        )
        self.app.add_object(self.points['ahu1_supply_temp'])
        
        self.points['ahu1_return_temp'] = AnalogInputObject(
            objectIdentifier="analog-input,11",
            objectName="AHU-1 Return Temp",
            presentValue=Real(22.0)
        )
        self.app.add_object(self.points['ahu1_return_temp'])
        
        self.points['ahu1_airflow'] = AnalogInputObject(
            objectIdentifier="analog-input,12",
            objectName="AHU-1 Airflow",
            presentValue=Real(5000.0)
        )
        self.app.add_object(self.points['ahu1_airflow'])
        
        self.points['ahu1_cooling_valve'] = AnalogInputObject(
            objectIdentifier="analog-input,13",
            objectName="AHU-1 Cooling Valve",
            presentValue=Real(45.0)
        )
        self.app.add_object(self.points['ahu1_cooling_valve'])
        
        self.points['ahu1_fan_status'] = BinaryInputObject(
            objectIdentifier="binary-input,14",
            objectName="AHU-1 Fan Status",
            presentValue=Enumerated(1)
        )
        self.app.add_object(self.points['ahu1_fan_status'])
        
        # AHU-2 points
        self.points['ahu2_supply_temp'] = AnalogInputObject(
            objectIdentifier="analog-input,20",
            objectName="AHU-2 Supply Temp",
            presentValue=Real(18.0)
        )
        self.app.add_object(self.points['ahu2_supply_temp'])
        
        self.points['ahu2_return_temp'] = AnalogInputObject(
            objectIdentifier="analog-input,21",
            objectName="AHU-2 Return Temp",
            presentValue=Real(22.0)
        )
        self.app.add_object(self.points['ahu2_return_temp'])
        
        self.points['ahu2_airflow'] = AnalogInputObject(
            objectIdentifier="analog-input,22",
            objectName="AHU-2 Airflow",
            presentValue=Real(5000.0)
        )
        self.app.add_object(self.points['ahu2_airflow'])
        
        self.points['ahu2_cooling_valve'] = AnalogInputObject(
            objectIdentifier="analog-input,23",
            objectName="AHU-2 Cooling Valve",
            presentValue=Real(45.0)
        )
        self.app.add_object(self.points['ahu2_cooling_valve'])
        
        self.points['ahu2_fan_status'] = BinaryInputObject(
            objectIdentifier="binary-input,24",
            objectName="AHU-2 Fan Status",
            presentValue=Enumerated(1)
        )
        self.app.add_object(self.points['ahu2_fan_status'])
        
        print(f"✓ Created device 'Condo-Building-1' (device ID: 1001)")
        print(f"✓ Registered {len(self.points)} BACnet points")
        print(f"✓ BACnet listener ready on port 47808/udp\n")
        
    async def update_simulation(self):
        """Continuous simulation loop"""
        while True:
            await asyncio.sleep(5)
            
            # Simple day/night cycle
            self.time_of_day = (self.time_of_day + 0.2) % 24
            hour_offset = (self.time_of_day - 15) / 24 * 2 * math.pi
            self.outdoor_temp = 25.0 + 8.0 * math.sin(hour_offset)
            
            # Update chiller points
            self.points['chiller_supply_temp'].presentValue = Real(7.0 + random.uniform(-0.3, 0.3))
            self.points['chiller_return_temp'].presentValue = Real(12.0 + random.uniform(-0.3, 0.3))
            
            load_factor = 0.6 + 0.3 * (self.outdoor_temp - 25.0) / 8.0
            power = 85.0 * max(0.3, min(1.0, load_factor)) + random.uniform(-3, 3)
            self.points['chiller_power'].presentValue = Real(power)
            
            # Update AHU-1 points
            self.points['ahu1_supply_temp'].presentValue = Real(18.0 + random.uniform(-1.0, 1.0))
            self.points['ahu1_return_temp'].presentValue = Real(22.0 + (self.outdoor_temp - 25.0) * 0.2 + random.uniform(-0.5, 0.5))
            self.points['ahu1_airflow'].presentValue = Real(5000.0 + random.uniform(-200, 200))
            self.points['ahu1_cooling_valve'].presentValue = Real(max(0, min(100, 45 + (self.outdoor_temp - 25.0) * 2 + random.uniform(-5, 5))))
            self.points['ahu1_fan_status'].presentValue = Enumerated(1 if random.random() > 0.1 else 0)
            
            # Update AHU-2 points
            self.points['ahu2_supply_temp'].presentValue = Real(18.0 + random.uniform(-1.0, 1.0))
            self.points['ahu2_return_temp'].presentValue = Real(22.0 + (self.outdoor_temp - 25.0) * 0.2 + random.uniform(-0.5, 0.5))
            self.points['ahu2_airflow'].presentValue = Real(5000.0 + random.uniform(-200, 200))
            self.points['ahu2_cooling_valve'].presentValue = Real(max(0, min(100, 45 + (self.outdoor_temp - 25.0) * 2 + random.uniform(-5, 5))))
            self.points['ahu2_fan_status'].presentValue = Enumerated(1 if random.random() > 0.1 else 0)
            
            # Log every 30 seconds
            elapsed = (datetime.now() - self.start_time).total_seconds()
            if int(elapsed) % 30 == 0:
                print(f"[{int(self.time_of_day):02d}:{int((self.time_of_day % 1) * 60):02d}] "
                      f"Outdoor Temp: {self.outdoor_temp:.1f}°C | "
                      f"Chiller Power: {self.points['chiller_power'].presentValue:.1f}kW | "
                      f"AHU-1 Valve: {self.points['ahu1_cooling_valve'].presentValue:.0f}%")
    
    async def run(self):
        """Main entry point"""
        print("\nStarting Condo BACnet Simulator...")
        
        await self.initialize()
        
        # Start continuous simulation updates
        asyncio.create_task(self.update_simulation())
        
        # Keep running forever
        while True:
            await asyncio.sleep(1)

# --- Run ---
if __name__ == "__main__":
    sim = CondoSimulator()
    try:
        asyncio.run(sim.run())
    except KeyboardInterrupt:
        print("\nSimulator stopped by user")
