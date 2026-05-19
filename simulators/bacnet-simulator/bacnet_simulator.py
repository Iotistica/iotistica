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
from bacpypes3.primitivedata import Real
from bacpypes3.basetypes import EngineeringUnits, BinaryPV
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
        source = apdu.pduSource
        is_unicast_source = not _is_broadcast_address(source)

        if is_unicast_source:
            print(f"[BACnet] Sending unicast I-Am to {source} (device {device_id})")
            self.i_am(address=source)
        else:
            print(f"[BACnet] Sending broadcast I-Am (device {device_id})")
            self.i_am()

def _is_broadcast_address(source) -> bool:
    """Return True if the BACnet source address is a broadcast or unspecified address.

    Isolating this heuristic here means future improvements (BBMD, IPv6, etc.)
    only need to be made in one place.
    """
    if source is None:
        return True
    s = str(source)
    return (
        s.endswith('.255:47808') or
        s in ('*:47808', '<broadcast>:47808')
    )


def _add_ai(
    app,
    points: dict,
    key: str,
    instance: int,
    name: str,
    value: float,
    units: str,
) -> None:
    """Register an AnalogInputObject and store it in the points dict."""
    obj = AnalogInputObject(
        objectIdentifier=f"analog-input,{instance}",
        objectName=name,
        presentValue=Real(value),
        units=EngineeringUnits(units),
    )
    app.add_object(obj)
    points[key] = obj


def _add_bi(
    app,
    points: dict,
    key: str,
    instance: int,
    name: str,
    active: bool = True,
) -> None:
    """Register a BinaryInputObject and store it in the points dict."""
    obj = BinaryInputObject(
        objectIdentifier=f"binary-input,{instance}",
        objectName=name,
        presentValue=BinaryPV("active" if active else "inactive"),
    )
    app.add_object(obj)
    points[key] = obj


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
            description="Condo HVAC Simulator",
            modelName="Iotistica BACnet Simulator",
            vendorName="Iotistica",
            applicationSoftwareVersion="1.0",
            location="Condo-Building-1",
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
        _add_bi(self.app, self.points, 'chiller_status', 1, 'Chiller-1 Status', active=True)
        _add_ai(self.app, self.points, 'chiller_supply_temp', 2, 'Chiller-1 Supply Temp', 7.0, 'degrees-celsius')
        _add_ai(self.app, self.points, 'chiller_return_temp', 3, 'Chiller-1 Return Temp', 12.0, 'degrees-celsius')
        _add_ai(self.app, self.points, 'chiller_power', 4, 'Chiller-1 Power', 85.0, 'kilowatts')

        # AHU-1 points
        _add_ai(self.app, self.points, 'ahu1_supply_temp', 10, 'AHU-1 Supply Temp', 18.0, 'degrees-celsius')
        _add_ai(self.app, self.points, 'ahu1_return_temp', 11, 'AHU-1 Return Temp', 22.0, 'degrees-celsius')
        _add_ai(self.app, self.points, 'ahu1_airflow', 12, 'AHU-1 Airflow', 5000.0, 'cubic-feet-per-minute')
        _add_ai(self.app, self.points, 'ahu1_cooling_valve', 13, 'AHU-1 Cooling Valve', 45.0, 'percent')
        _add_bi(self.app, self.points, 'ahu1_fan_status', 14, 'AHU-1 Fan Status', active=True)

        # AHU-2 points
        _add_ai(self.app, self.points, 'ahu2_supply_temp', 20, 'AHU-2 Supply Temp', 18.0, 'degrees-celsius')
        _add_ai(self.app, self.points, 'ahu2_return_temp', 21, 'AHU-2 Return Temp', 22.0, 'degrees-celsius')
        _add_ai(self.app, self.points, 'ahu2_airflow', 22, 'AHU-2 Airflow', 5000.0, 'cubic-feet-per-minute')
        _add_ai(self.app, self.points, 'ahu2_cooling_valve', 23, 'AHU-2 Cooling Valve', 45.0, 'percent')
        _add_bi(self.app, self.points, 'ahu2_fan_status', 24, 'AHU-2 Fan Status', active=True)
        
        print(f"✓ Registered {len(self.points)} BACnet points")
        
    async def update_simulation(self):
        """Continuous simulation loop"""
        last_log_time: datetime | None = None
        while True:
            await asyncio.sleep(5)

            # Simple day/night cycle
            self.time_of_day = (self.time_of_day + 0.2) % 24
            hour_offset = (self.time_of_day - 15) / 24 * 2 * math.pi
            self.outdoor_temp = 25.0 + 8.0 * math.sin(hour_offset)

            # Chiller load factor drives status and power
            load_factor = 0.6 + 0.3 * (self.outdoor_temp - 25.0) / 8.0
            chiller_running = load_factor > 0.3 and random.random() > 0.02
            self.points['chiller_status'].presentValue = BinaryPV('active' if chiller_running else 'inactive')
            self.points['chiller_supply_temp'].presentValue = Real(7.0 + random.uniform(-0.3, 0.3))
            self.points['chiller_return_temp'].presentValue = Real(12.0 + random.uniform(-0.3, 0.3))
            power = 85.0 * max(0.3, min(1.0, load_factor)) + random.uniform(-3, 3)
            self.points['chiller_power'].presentValue = Real(power)

            # AHU-1
            self.points['ahu1_fan_status'].presentValue = BinaryPV('active' if random.random() > 0.05 else 'inactive')
            self.points['ahu1_supply_temp'].presentValue = Real(18.0 + random.uniform(-1.0, 1.0))
            self.points['ahu1_return_temp'].presentValue = Real(22.0 + (self.outdoor_temp - 25.0) * 0.2 + random.uniform(-0.5, 0.5))
            self.points['ahu1_airflow'].presentValue = Real(5000.0 + random.uniform(-200, 200))
            self.points['ahu1_cooling_valve'].presentValue = Real(max(0, min(100, 45 + (self.outdoor_temp - 25.0) * 2 + random.uniform(-5, 5))))

            # AHU-2
            self.points['ahu2_fan_status'].presentValue = BinaryPV('active' if random.random() > 0.05 else 'inactive')
            self.points['ahu2_supply_temp'].presentValue = Real(18.0 + random.uniform(-1.0, 1.0))
            self.points['ahu2_return_temp'].presentValue = Real(22.0 + (self.outdoor_temp - 25.0) * 0.2 + random.uniform(-0.5, 0.5))
            self.points['ahu2_airflow'].presentValue = Real(5000.0 + random.uniform(-200, 200))
            self.points['ahu2_cooling_valve'].presentValue = Real(max(0, min(100, 45 + (self.outdoor_temp - 25.0) * 2 + random.uniform(-5, 5))))

            # Log all 14 BACnet points every 30 seconds (time-based, not modulo)
            now = datetime.now()
            if last_log_time is None or (now - last_log_time).total_seconds() >= 30:
                last_log_time = now
                ts = now.strftime('%Y-%m-%d %H:%M:%S')
                W = 26  # label column width
                print(
                    f"[{ts}] Outdoor: {self.outdoor_temp:.1f}°C | {len(self.points)} points\n"
                    f"  {'Chiller-1 Status':<{W}}: {'ON' if self.points['chiller_status'].presentValue == BinaryPV('active') else 'OFF'}\n"
                    f"  {'Chiller-1 Supply Temp':<{W}}: {self.points['chiller_supply_temp'].presentValue:.1f}°C\n"
                    f"  {'Chiller-1 Return Temp':<{W}}: {self.points['chiller_return_temp'].presentValue:.1f}°C\n"
                    f"  {'Chiller-1 Power':<{W}}: {self.points['chiller_power'].presentValue:.1f}kW\n"
                    f"  {'AHU-1 Fan Status':<{W}}: {'ON' if self.points['ahu1_fan_status'].presentValue == BinaryPV('active') else 'OFF'}\n"
                    f"  {'AHU-1 Supply Temp':<{W}}: {self.points['ahu1_supply_temp'].presentValue:.1f}°C\n"
                    f"  {'AHU-1 Return Temp':<{W}}: {self.points['ahu1_return_temp'].presentValue:.1f}°C\n"
                    f"  {'AHU-1 Airflow':<{W}}: {self.points['ahu1_airflow'].presentValue:.0f}cfm\n"
                    f"  {'AHU-1 Cooling Valve':<{W}}: {self.points['ahu1_cooling_valve'].presentValue:.0f}%\n"
                    f"  {'AHU-2 Fan Status':<{W}}: {'ON' if self.points['ahu2_fan_status'].presentValue == BinaryPV('active') else 'OFF'}\n"
                    f"  {'AHU-2 Supply Temp':<{W}}: {self.points['ahu2_supply_temp'].presentValue:.1f}°C\n"
                    f"  {'AHU-2 Return Temp':<{W}}: {self.points['ahu2_return_temp'].presentValue:.1f}°C\n"
                    f"  {'AHU-2 Airflow':<{W}}: {self.points['ahu2_airflow'].presentValue:.0f}cfm\n"
                    f"  {'AHU-2 Cooling Valve':<{W}}: {self.points['ahu2_cooling_valve'].presentValue:.0f}%"
                )
    
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
