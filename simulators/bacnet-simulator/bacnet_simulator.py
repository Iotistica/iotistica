import asyncio
import random
import math
import os
import socket
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Union
from bacpypes3.local.device import DeviceObject
from bacpypes3.local.analog import AnalogInputObject
from bacpypes3.local.binary import BinaryInputObject
from bacpypes3.app import Application
from bacpypes3.primitivedata import Real
from bacpypes3.basetypes import EngineeringUnits, BinaryPV
from bacpypes3.debugging import bacpypes_debugging, ModuleLogger
from bacpypes3.local.networkport import NetworkPortObject
from bacpypes3.apdu import ReadPropertyACK
from bacpypes3.primitivedata import ObjectIdentifier

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


def _is_device_object_identifier(objid) -> bool:
    """Return True for BACnet device object identifiers in string or numeric form."""
    if not isinstance(objid, tuple) or len(objid) != 2:
        return False
    obj_type = objid[0]
    if obj_type == 'device':
        return True
    try:
        return int(obj_type) == 8
    except Exception:
        return False


@bacpypes_debugging
class MultiDeviceApplication(ResponsiveApplication):
    """Application that serves multiple virtual BACnet devices on a single UDP port.

    One Application owns the UDP socket (port 47808). Each logical BACnet device
    (e.g., chiller plant, AHU controller) is registered with a non-overlapping
    BACnet object-instance range so the standard ReadProperty handler can route
    requests to the correct object without modification.

    The overridden do_WhoIsRequest sends I-Am for every registered device ID so
    all devices appear discoverable on the network despite sharing one IP:port.
    """

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        # device_id (int) -> DeviceObject — populated by Building.initialize()
        self._virtual_devices: dict = {}
        self._virtual_object_lists: dict[int, list] = {}

    def get_object_id(self, objid):
        """Resolve virtual DeviceObjects not present in Application.objectIdentifier."""
        obj = super().get_object_id(objid)
        if obj is not None:
            return obj
        if _is_device_object_identifier(objid):
            return self._virtual_devices.get(int(objid[1]))
        return None

    async def do_WhoIsRequest(self, apdu) -> None:
        """Respond with I-Am for every virtual device whose ID is in range."""
        if _debug:
            _log.debug(f"[BACnet] Multi-device Who-Is from {apdu.pduSource}")

        low = apdu.deviceInstanceRangeLowLimit
        high = apdu.deviceInstanceRangeHighLimit
        source = apdu.pduSource
        is_unicast = not _is_broadcast_address(source)

        saved = self.device_object
        try:
            for device_id, dev_obj in self._virtual_devices.items():
                in_range = (
                    (low is None and high is None)
                    or (
                        low is not None
                        and high is not None
                        and low <= device_id <= high
                    )
                )
                if not in_range:
                    continue
                # Temporarily swap device_object so i_am() encodes the correct
                # device ID. asyncio is single-threaded so this swap is safe.
                self.device_object = dev_obj
                if is_unicast:
                    print(f"[BACnet] Sending unicast I-Am for device {device_id} to {source}")
                    self.i_am(address=source)
                else:
                    print(f"[BACnet] Sending broadcast I-Am for device {device_id}")
                    self.i_am()
        finally:
            self.device_object = saved

    async def do_ReadPropertyRequest(self, apdu) -> None:
        """Serve key DeviceObject properties for virtual devices not registered in app state."""
        objid = apdu.objectIdentifier
        if _is_device_object_identifier(objid):
            device_id = int(objid[1])
            virtual = self._virtual_devices.get(device_id)
            if virtual is not None:
                prop = apdu.propertyIdentifier
                try:
                    prop_code = int(prop)
                except Exception:
                    prop_code = getattr(prop, 'value', prop)

                if prop_code == 76:
                    object_list_cls = DeviceObject._elements.get('objectList')
                    raw_list = self._virtual_object_lists.get(device_id, [])
                    value = object_list_cls([ObjectIdentifier(obj) for obj in raw_list])
                elif prop_code == 77:
                    value = virtual.objectName
                elif prop_code == 121:
                    value = virtual.vendorName
                elif prop_code == 70:
                    value = virtual.modelName
                elif prop_code == 28:
                    value = virtual.description
                else:
                    await super().do_ReadPropertyRequest(apdu)
                    return

                resp = ReadPropertyACK(
                    objectIdentifier=objid,
                    propertyIdentifier=prop,
                    propertyArrayIndex=apdu.propertyArrayIndex,
                    propertyValue=value,
                    context=apdu,
                )
                await self.response(resp)
                return

        await super().do_ReadPropertyRequest(apdu)


def _resolve_base_ip() -> str:
    """Extract the host IP from BACPYPES_IFACE env var, or auto-detect.

    Returns '0.0.0.0' when BACPYPES_IFACE is the bind-all form, which is
    correct for Docker host-network containers — each BACnetDevice will bind
    to 0.0.0.0:<port> and all ports are reachable on the host network.
    """
    iface = os.environ.get('BACPYPES_IFACE', '')
    if iface:
        # Strip port and subnet prefix: "10.0.0.1:47808/24" -> "10.0.0.1"
        # Also handles "0.0.0.0:47808" -> "0.0.0.0"
        ip = iface.split(':')[0].split('/')[0]
        if ip:
            return ip
    try:
        hostname = socket.gethostname()
        ip = socket.gethostbyname(hostname)
        if ip and ip != '127.0.0.1':
            return ip
    except Exception:
        pass
    return '0.0.0.0'


# ---------------------------------------------------------------------------
# Simulation state  (shared across all devices each tick)
# ---------------------------------------------------------------------------

@dataclass
class SimState:
    """Shared simulation state advanced by the Building update loop."""

    time_of_day: float = 12.0   # 0-24 float
    outdoor_temp: float = 25.0  # degrees Celsius
    chiller_load: float = 0.6   # 0-1 normalised


# ---------------------------------------------------------------------------
# Simulation behaviors  (stateless, pure functions of SimState)
# ---------------------------------------------------------------------------

class SimulationBehavior(ABC):
    """Computes a point's present value from the current SimState."""

    @abstractmethod
    def compute(self, state: SimState) -> Union[float, bool]:
        ...


class ConstantBehavior(SimulationBehavior):
    def __init__(self, value: float) -> None:
        self.value = value

    def compute(self, state: SimState) -> float:
        return self.value


class NoisyBehavior(SimulationBehavior):
    """Adds uniform noise to a wrapped behavior."""

    def __init__(self, wrapped: SimulationBehavior, noise: float) -> None:
        self.wrapped = wrapped
        self.noise = noise

    def compute(self, state: SimState) -> float:
        return float(self.wrapped.compute(state)) + random.uniform(-self.noise, self.noise)


class ChillerStatusBehavior(SimulationBehavior):
    def __init__(self, min_load: float = 0.3, fault_rate: float = 0.02) -> None:
        self.min_load = min_load
        self.fault_rate = fault_rate

    def compute(self, state: SimState) -> bool:
        return state.chiller_load > self.min_load and random.random() > self.fault_rate


class ChillerPowerBehavior(SimulationBehavior):
    def __init__(self, rated_kw: float = 85.0, noise: float = 3.0) -> None:
        self.rated_kw = rated_kw
        self.noise = noise

    def compute(self, state: SimState) -> float:
        return (
            self.rated_kw * max(0.3, min(1.0, state.chiller_load))
            + random.uniform(-self.noise, self.noise)
        )


class FanStatusBehavior(SimulationBehavior):
    def __init__(self, fault_rate: float = 0.05) -> None:
        self.fault_rate = fault_rate

    def compute(self, state: SimState) -> bool:
        return random.random() > self.fault_rate


class ReturnTempBehavior(SimulationBehavior):
    def __init__(
        self,
        base: float = 22.0,
        outdoor_sensitivity: float = 0.2,
        noise: float = 0.5,
    ) -> None:
        self.base = base
        self.outdoor_sensitivity = outdoor_sensitivity
        self.noise = noise

    def compute(self, state: SimState) -> float:
        return (
            self.base
            + (state.outdoor_temp - 25.0) * self.outdoor_sensitivity
            + random.uniform(-self.noise, self.noise)
        )


class AirflowBehavior(SimulationBehavior):
    def __init__(self, rated_cfm: float = 5000.0, noise: float = 200.0) -> None:
        self.rated_cfm = rated_cfm
        self.noise = noise

    def compute(self, state: SimState) -> float:
        return self.rated_cfm + random.uniform(-self.noise, self.noise)


class ValveBehavior(SimulationBehavior):
    def __init__(
        self,
        base: float = 45.0,
        sensitivity: float = 2.0,
        noise: float = 5.0,
    ) -> None:
        self.base = base
        self.sensitivity = sensitivity
        self.noise = noise

    def compute(self, state: SimState) -> float:
        return max(
            0.0,
            min(
                100.0,
                self.base
                + (state.outdoor_temp - 25.0) * self.sensitivity
                + random.uniform(-self.noise, self.noise),
            ),
        )


# ---------------------------------------------------------------------------
# Building model  (Point -> Equipment -> BACnetDevice -> Building)
# ---------------------------------------------------------------------------

@dataclass
class Point:
    """A single BACnet object with an associated simulation behavior."""

    key: str
    instance: int
    name: str
    object_type: str                    # 'analog-input' or 'binary-input'
    behavior: SimulationBehavior
    units: Optional[str] = None         # only meaningful for analog-input
    _obj: object = field(default=None, init=False, repr=False)

    def create_bacnet_object(self, state: SimState, instance_offset: int = 0) -> object:
        """Create the bacpypes3 object without registering it into an Application.

        The physical BACnet instance number is ``self.instance + instance_offset``
        so that objects from different logical devices can coexist in a single
        Application without colliding on instance numbers.
        """
        phys = self.instance + instance_offset
        initial = self.behavior.compute(state)
        if self.object_type == 'analog-input':
            self._obj = AnalogInputObject(
                objectIdentifier=f"analog-input,{phys}",
                objectName=self.name,
                presentValue=Real(float(initial)),
                units=EngineeringUnits(self.units),
            )
        else:
            self._obj = BinaryInputObject(
                objectIdentifier=f"binary-input,{phys}",
                objectName=self.name,
                presentValue=BinaryPV('active' if initial else 'inactive'),
            )
        return self._obj

    def register(self, app, state: SimState, instance_offset: int = 0) -> None:
        """Create and register the BACnet object with an initial value."""
        obj = self.create_bacnet_object(state, instance_offset)
        app.add_object(obj)

    def update(self, state: SimState) -> None:
        """Recompute and apply a new present value."""
        if self._obj is None:
            return
        val = self.behavior.compute(state)
        if self.object_type == 'analog-input':
            self._obj.presentValue = Real(float(val))
        else:
            self._obj.presentValue = BinaryPV('active' if val else 'inactive')

    @property
    def present_value(self):
        return self._obj.presentValue if self._obj is not None else None


@dataclass
class Equipment:
    """A logical grouping of points (e.g. one chiller, one AHU)."""

    name: str
    points: list = field(default_factory=list)   # list[Point]

    def register(self, app, state: SimState, instance_offset: int = 0) -> None:
        for point in self.points:
            point.register(app, state, instance_offset)

    def update(self, state: SimState) -> None:
        for point in self.points:
            point.update(state)


class BACnetDevice:
    """One logical BACnet device hosted by the shared Application."""

    def __init__(
        self,
        device_id: int,
        name: str,
        port: int = 47808,
        description: str = "",
        equipment: Optional[list] = None,
    ) -> None:
        self.device_id = device_id
        self.name = name
        self.port = port
        self.description = description
        self.equipment: list[Equipment] = equipment or []
        self.app: Optional[MultiDeviceApplication] = None
        self.device_obj: Optional[DeviceObject] = None
        self.instance_offset: int = 0  # Set by Building.initialize()

    @property
    def points(self) -> list:
        return [p for equip in self.equipment for p in equip.points]

    def update(self, state: SimState) -> None:
        for equip in self.equipment:
            equip.update(state)


class Building:
    """Top-level container: manages all devices and drives the simulation loop."""

    def __init__(self, name: str, devices: list) -> None:
        self.name = name
        self.devices: list[BACnetDevice] = devices
        self.state = SimState()
        self.app: Optional[MultiDeviceApplication] = None

    async def initialize(self) -> None:
        base_ip = _resolve_base_ip()
        total_points = sum(len(d.points) for d in self.devices)
        print(f"\nStarting Building Simulator: {self.name}")
        print(f"  Base IP : {base_ip}")
        print(f"  Devices : {len(self.devices)}")
        print(f"  Points  : {total_points} total")

        loop = asyncio.get_running_loop()
        _orig = loop.get_exception_handler()

        def _exception_handler(loop, context):
            exc = context.get('exception')
            if isinstance(exc, RuntimeError) and str(exc) == 'no broadcast':
                return
            if _orig:
                _orig(loop, context)
            else:
                loop.default_exception_handler(context)

        loop.set_exception_handler(_exception_handler)

        # Host all logical BACnet devices on one UDP port so Who-Is/I-Am discovery
        # works with standard BACnet/IP tooling that targets 47808.
        shared_port = 47808
        bind_addr = f"{base_ip}:{shared_port}"
        primary = self.devices[0]

        primary_device_obj = DeviceObject(
            objectIdentifier=f"device,{primary.device_id}",
            objectName=primary.name,
            vendorIdentifier=999,
            description=primary.description,
            modelName="Iotistica BACnet Simulator",
            vendorName="Iotistica",
            applicationSoftwareVersion="2.0",
            location=primary.name,
        )
        network_port = NetworkPortObject(
            bind_addr,
            objectIdentifier=("network-port", 1),
            objectName="NetworkPort-1",
        )

        self.app = MultiDeviceApplication.from_object_list([primary_device_obj, network_port])
        await asyncio.sleep(0.5)
        primary.device_obj = primary_device_obj
        self.app._virtual_devices[primary.device_id] = primary_device_obj

        print(f"\n[Building] Shared BACnet socket on {bind_addr}")

        # Reserve 1000 object-instance slots per logical device to avoid collisions.
        for idx, device in enumerate(self.devices):
            device.app = self.app
            device.port = shared_port
            device.instance_offset = idx * 1000

            if idx != 0:
                dev_obj = DeviceObject(
                    objectIdentifier=f"device,{device.device_id}",
                    objectName=device.name,
                    vendorIdentifier=999,
                    description=device.description,
                    modelName="Iotistica BACnet Simulator",
                    vendorName="Iotistica",
                    applicationSoftwareVersion="2.0",
                    location=device.name,
                )
                device.device_obj = dev_obj
                self.app._virtual_devices[device.device_id] = dev_obj
            else:
                device.device_obj = primary_device_obj

            for equip in device.equipment:
                equip.register(self.app, self.state, instance_offset=device.instance_offset)

            object_list = [device.device_obj.objectIdentifier]
            if idx == 0:
                object_list.append(network_port.objectIdentifier)
            object_list.extend(
                point._obj.objectIdentifier
                for equip in device.equipment
                for point in equip.points
                if point._obj is not None
            )
            device.device_obj.objectList = object_list
            self.app._virtual_object_lists[device.device_id] = object_list

            total_points = len(device.points)
            print(
                f"[Device {device.device_id}] Ready -- "
                f"{len(device.equipment)} equipment group(s), {total_points} point(s), "
                f"instance_offset={device.instance_offset}, object_list={len(object_list)}"
            )

        # Announce all virtual devices once at startup.
        self.app.i_am()
        saved = self.app.device_object
        try:
            for device_id, dev_obj in self.app._virtual_devices.items():
                if device_id == primary.device_id:
                    continue
                self.app.device_object = dev_obj
                self.app.i_am()
        finally:
            self.app.device_object = saved

    async def _update_loop(self) -> None:
        last_log: Optional[datetime] = None
        while True:
            await asyncio.sleep(5)

            # Advance shared simulation state
            self.state.time_of_day = (self.state.time_of_day + 0.2) % 24
            hour_offset = (self.state.time_of_day - 15.0) / 24.0 * 2.0 * math.pi
            self.state.outdoor_temp = 25.0 + 8.0 * math.sin(hour_offset)
            self.state.chiller_load = 0.6 + 0.3 * (self.state.outdoor_temp - 25.0) / 8.0

            for device in self.devices:
                device.update(self.state)

            now = datetime.now()
            if last_log is None or (now - last_log).total_seconds() >= 30:
                last_log = now
                self._log_status(now)

    def _log_status(self, now: datetime) -> None:
        ts = now.strftime('%Y-%m-%d %H:%M:%S')
        total_points = sum(len(d.points) for d in self.devices)
        print(
            f"\n[{ts}] {self.name}"
            f" | Outdoor: {self.state.outdoor_temp:.1f}C"
            f" | {len(self.devices)} device(s), {total_points} point(s)"
        )
        W = 32
        for device in self.devices:
            print(f"  [Device {device.device_id}:{device.port}] {device.name}")
            for equip in device.equipment:
                print(f"    [{equip.name}]")
                for point in equip.points:
                    val = point.present_value
                    if isinstance(val, BinaryPV):
                        display = 'ON' if val == BinaryPV('active') else 'OFF'
                    else:
                        display = f"{float(val):.1f}"
                    print(f"      {point.name:<{W}}: {display}")

    async def run(self) -> None:
        await self.initialize()
        asyncio.create_task(self._update_loop())
        while True:
            await asyncio.sleep(1)


# ---------------------------------------------------------------------------
# Device factories
# ---------------------------------------------------------------------------

def make_chiller_plant(
    device_id: int = 1001,
    port: int = 47808,
    chiller_count: int = 1,
) -> BACnetDevice:
    """Central plant: one BACnet device, one Equipment group per chiller."""
    equipment = []
    for i in range(1, chiller_count + 1):
        offset = (i - 1) * 10
        equipment.append(Equipment(
            name=f"Chiller-{i}",
            points=[
                Point(
                    f"chiller{i}_status", 1 + offset, f"Chiller-{i} Status",
                    'binary-input', ChillerStatusBehavior(),
                ),
                Point(
                    f"chiller{i}_supply_temp", 2 + offset, f"Chiller-{i} Supply Temp",
                    'analog-input', NoisyBehavior(ConstantBehavior(7.0), 0.3),
                    'degrees-celsius',
                ),
                Point(
                    f"chiller{i}_return_temp", 3 + offset, f"Chiller-{i} Return Temp",
                    'analog-input', NoisyBehavior(ConstantBehavior(12.0), 0.3),
                    'degrees-celsius',
                ),
                Point(
                    f"chiller{i}_power", 4 + offset, f"Chiller-{i} Power",
                    'analog-input', ChillerPowerBehavior(rated_kw=85.0),
                    'kilowatts',
                ),
            ],
        ))
    return BACnetDevice(
        device_id=device_id,
        name="Central-Plant",
        port=port,
        description="Central chiller plant",
        equipment=equipment,
    )


def make_ahu_controller(
    ahu_number: int,
    device_id: int,
    port: int,
    rated_cfm: float = 5000.0,
) -> BACnetDevice:
    """AHU controller: one BACnet device per air handling unit."""
    return BACnetDevice(
        device_id=device_id,
        name=f"AHU-{ahu_number}-Controller",
        port=port,
        description=f"Air handling unit {ahu_number} controller",
        equipment=[Equipment(
            name=f"AHU-{ahu_number}",
            points=[
                Point(
                    f"ahu{ahu_number}_fan_status", 1, f"AHU-{ahu_number} Fan Status",
                    'binary-input', FanStatusBehavior(),
                ),
                Point(
                    f"ahu{ahu_number}_supply_temp", 2, f"AHU-{ahu_number} Supply Temp",
                    'analog-input', NoisyBehavior(ConstantBehavior(18.0), 1.0),
                    'degrees-celsius',
                ),
                Point(
                    f"ahu{ahu_number}_return_temp", 3, f"AHU-{ahu_number} Return Temp",
                    'analog-input', ReturnTempBehavior(),
                    'degrees-celsius',
                ),
                Point(
                    f"ahu{ahu_number}_airflow", 4, f"AHU-{ahu_number} Airflow",
                    'analog-input', AirflowBehavior(rated_cfm),
                    'cubic-feet-per-minute',
                ),
                Point(
                    f"ahu{ahu_number}_cooling_valve", 5, f"AHU-{ahu_number} Cooling Valve",
                    'analog-input', ValveBehavior(),
                    'percent',
                ),
            ],
        )],
    )


def make_condo_building(
    base_device_id: int = 1001,
    base_port: int = 47808,
    chillers: int = 1,
    ahus: int = 2,
) -> Building:
    """Declarative condo building factory.

        Creates:
            - 1 central plant device  (base_device_id)
            - N AHU controller devices (base_device_id+1..N)

        Runtime note:
            All logical devices are hosted on one shared BACnet/IP socket/port (47808)
            so standard Who-Is broadcast discovers every device ID.
    """
    devices = [
        make_chiller_plant(
            device_id=base_device_id,
            port=base_port,
            chiller_count=chillers,
        )
    ]
    for i in range(1, ahus + 1):
        devices.append(make_ahu_controller(
            ahu_number=i,
            device_id=base_device_id + i,
            port=base_port,
        ))
    return Building(name="Condo-Building-1", devices=devices)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    building = make_condo_building(chillers=1, ahus=2)
    try:
        asyncio.run(building.run())
    except KeyboardInterrupt:
        print("\nSimulator stopped by user")
