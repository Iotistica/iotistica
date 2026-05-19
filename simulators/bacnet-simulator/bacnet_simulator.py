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
from bacpypes3.basetypes import EngineeringUnits
from bacpypes3.debugging import bacpypes_debugging, ModuleLogger
from bacpypes3.local.networkport import NetworkPortObject

# Enable debug logging
_debug = 1
_log = ModuleLogger(globals())

# Custom Application that responds to Who-Is requests
@bacpypes_debugging
class ResponsiveApplication(Application):
    """BACnet application that explicitly handles Who-Is requests"""

    async def do_WhoIsRequest(self, apdu) -> None:
        """Handle incoming Who-Is request and respond with I-Am.

        Unicast vs broadcast I-Am strategy (mirrors Ignition Scenario 2):
          - If Who-Is arrived from a specific unicast address, respond unicast
            directly back to the requester so the response crosses subnet/network
            boundaries (e.g. Docker bridge → host network_mode agent).
          - If Who-Is arrived via broadcast (pduSource is None or a broadcast
            address), respond with a normal broadcast I-Am so any listener on
            the local subnet can hear it (Scenario 1 / same broadcast domain).
        """
        if _debug:
            _log.debug(f"[BACnet] Processing Who-Is from {apdu.pduSource}")

        print(f"[BACnet] Received Who-Is request from {apdu.pduSource}")

        device_id = self.device_object.objectIdentifier[1]
        low_limit = apdu.deviceInstanceRangeLowLimit
        high_limit = apdu.deviceInstanceRangeHighLimit

        should_respond = (
            (low_limit is None and high_limit is None) or
            (low_limit is not None and high_limit is not None and low_limit <= device_id <= high_limit)
        )

        if not should_respond:
            print(f"[BACnet] Device {device_id} not in range {low_limit}-{high_limit}, ignoring")
            return

        # Determine whether to respond unicast or broadcast.
        # A unicast source address looks like "192.168.x.y:47808".
        # A broadcast source is None or ends with ".255:47808".
        source = apdu.pduSource
        is_unicast_source = (
            source is not None and
            not str(source).endswith('.255:47808') and
            str(source) not in ('*:47808', '<broadcast>:47808')
        )

        if is_unicast_source:
            print(f"[BACnet] Sending unicast I-Am to {source} (device {device_id})")
            self.i_am(address=source)
        else:
            print(f"[BACnet] Sending broadcast I-Am (device {device_id})")
            self.i_am()

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
            # bacpypes3 Address() accepts "ip", "ip/prefix", or "ip:port" — but NOT "ip:port/prefix".
            # Strip /prefix from the combined form (legacy bacpypes2 convention).
            if ':' in bind_addr and '/' in bind_addr:
                bind_addr = bind_addr.split('/')[0]  # "0.0.0.0:47808/24" → "0.0.0.0:47808"
            elif bind_addr.startswith('0.0.0.0/') or bind_addr == '0.0.0.0':
                # "0.0.0.0/24" doesn't make sense for broadcast calculation; use plain form
                bind_addr = '0.0.0.0:47808'
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
        
        # Create device object
        self.device = DeviceObject(
            objectIdentifier="device,1001",
            objectName="Condo-Building-1",
            vendorIdentifier=999,
        )
        
        # Create NetworkPortObject — this is what actually binds the UDP socket.
        # In bacpypes3, Application.__init__ does NOT set up any transport;
        # the transport is created by add_object(NetworkPortObject) inside
        # Application.from_object_list().
        # Use bacpypes3.local.networkport.NetworkPortObject (not the base class)
        # since it accepts an address string in its constructor.
        network_port = NetworkPortObject(
            bind_addr,
            objectIdentifier=("network-port", 1),
            objectName="NetworkPort-1",
        )
        
        # Create application using from_object_list which wires the full BACnet
        # stack: Application → ASAP → NSAP → NSE → NormalLinkLayer_ipv4 →
        # IPv4DatagramServer (the actual UDP socket on port 47808).
        self.app = ResponsiveApplication.from_object_list([self.device, network_port])
        
        # Give the event loop time to complete the async datagram endpoint creation
        await asyncio.sleep(0.5)
        
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
            presentValue=Real(7.0),
            units=EngineeringUnits("degrees-celsius")
        )
        self.app.add_object(self.points['chiller_supply_temp'])
        
        self.points['chiller_return_temp'] = AnalogInputObject(
            objectIdentifier="analog-input,3",
            objectName="Chiller-1 Return Temp",
            presentValue=Real(12.0),
            units=EngineeringUnits("degrees-celsius")
        )
        self.app.add_object(self.points['chiller_return_temp'])
        
        self.points['chiller_power'] = AnalogInputObject(
            objectIdentifier="analog-input,4",
            objectName="Chiller-1 Power",
            presentValue=Real(85.0),
            units=EngineeringUnits("kilowatts")
        )
        self.app.add_object(self.points['chiller_power'])
        
        # AHU-1 points
        self.points['ahu1_supply_temp'] = AnalogInputObject(
            objectIdentifier="analog-input,10",
            objectName="AHU-1 Supply Temp",
            presentValue=Real(18.0),
            units=EngineeringUnits("degrees-celsius")
        )
        self.app.add_object(self.points['ahu1_supply_temp'])
        
        self.points['ahu1_return_temp'] = AnalogInputObject(
            objectIdentifier="analog-input,11",
            objectName="AHU-1 Return Temp",
            presentValue=Real(22.0),
            units=EngineeringUnits("degrees-celsius")
        )
        self.app.add_object(self.points['ahu1_return_temp'])
        
        self.points['ahu1_airflow'] = AnalogInputObject(
            objectIdentifier="analog-input,12",
            objectName="AHU-1 Airflow",
            presentValue=Real(5000.0),
            units=EngineeringUnits("cubic-feet-per-minute")
        )
        self.app.add_object(self.points['ahu1_airflow'])
        
        self.points['ahu1_cooling_valve'] = AnalogInputObject(
            objectIdentifier="analog-input,13",
            objectName="AHU-1 Cooling Valve",
            presentValue=Real(45.0),
            units=EngineeringUnits("percent")
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
            presentValue=Real(18.0),
            units=EngineeringUnits("degrees-celsius")
        )
        self.app.add_object(self.points['ahu2_supply_temp'])
        
        self.points['ahu2_return_temp'] = AnalogInputObject(
            objectIdentifier="analog-input,21",
            objectName="AHU-2 Return Temp",
            presentValue=Real(22.0),
            units=EngineeringUnits("degrees-celsius")
        )
        self.app.add_object(self.points['ahu2_return_temp'])
        
        self.points['ahu2_airflow'] = AnalogInputObject(
            objectIdentifier="analog-input,22",
            objectName="AHU-2 Airflow",
            presentValue=Real(5000.0),
            units=EngineeringUnits("cubic-feet-per-minute")
        )
        self.app.add_object(self.points['ahu2_airflow'])
        
        self.points['ahu2_cooling_valve'] = AnalogInputObject(
            objectIdentifier="analog-input,23",
            objectName="AHU-2 Cooling Valve",
            presentValue=Real(45.0),
            units=EngineeringUnits("percent")
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
                print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] "
                      f"Outdoor Temp: {self.outdoor_temp:.1f}°C | "
                      f"Chiller Power: {self.points['chiller_power'].presentValue:.1f}kW | "
                      f"AHU-1 Valve: {self.points['ahu1_cooling_valve'].presentValue:.0f}%")
    
    async def run(self):
        """Main entry point"""
        print("\nStarting Condo BACnet Simulator...")

        # Suppress bacpypes3 "no broadcast" errors that occur when the host
        # network interface has no broadcast address (e.g. Docker Desktop
        # loopback / host-network mode on Windows/Mac).  These are raised
        # inside internal bacpypes3 tasks and do not affect unicast operation.
        loop = asyncio.get_running_loop()
        _orig_handler = loop.get_exception_handler()

        def _exception_handler(loop: asyncio.AbstractEventLoop, context: dict) -> None:
            exc = context.get('exception')
            if isinstance(exc, RuntimeError) and str(exc) == 'no broadcast':
                return  # benign — no broadcast route, unicast still works fine
            if _orig_handler:
                _orig_handler(loop, context)
            else:
                loop.default_exception_handler(context)

        loop.set_exception_handler(_exception_handler)
        
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
