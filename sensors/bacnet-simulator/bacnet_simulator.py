import asyncio
import random
import math
from datetime import datetime
from bacpypes3.local.device import DeviceObject
from bacpypes3.local.analog import AnalogInputObject
from bacpypes3.local.binary import BinaryInputObject
from bacpypes3.local.object import ObjectIdentifier, COVSubscription
from bacpypes3.app import Application
from bacpypes3.primitivedata import Real

# --- Base BACnet Device class ---
class BACnetDevice:
    def __init__(self, device_id, name, cov_increment_map=None):
        self.device_id = device_id
        self.name = name
        self.app = Application()  # BACnet application (BIP/IP can be added)
        self.device = DeviceObject(
            objectIdentifier=f"device,{device_id}",
            objectName=name,
            vendorIdentifier=999,
        )
        self.app.add_object(self.device)
        self.objects = {}  # key = objectIdentifier, value = {'obj', 'type'}
        self.cov_increment_map = cov_increment_map or {}

    def add_object(self, obj, obj_type):
        self.objects[obj.objectIdentifier] = {'obj': obj, 'type': obj_type}
        self.app.add_object(obj)

        # Setup COV for analog inputs
        if isinstance(obj, AnalogInputObject):
            cov_inc = self.cov_increment_map.get(obj_type, 0.1)
            cov = COVSubscription(
                subscriberProcessIdentifier=1,
                monitoredObject=obj,
                covIncrement=cov_inc,
                lifetime=3600,
            )
            obj.add_subscription(cov)

# --- Specific devices ---
class Chiller(BACnetDevice):
    def __init__(self, device_id, name):
        cov_map = {
            'chiller_supply_temp': 0.1,
            'chiller_return_temp': 0.1,
            'chiller_power': 5.0,
        }
        super().__init__(device_id, name, cov_map)

        # Points
        self.add_object(BinaryInputObject(
            objectIdentifier="binary-input,1",
            objectName=f"{name} Status",
            presentValue=1
        ), 'chiller_status')

        self.add_object(AnalogInputObject(
            objectIdentifier="analog-input,2",
            objectName=f"{name} Supply Temp",
            presentValue=Real(7.0)
        ), 'chiller_supply_temp')

        self.add_object(AnalogInputObject(
            objectIdentifier="analog-input,3",
            objectName=f"{name} Return Temp",
            presentValue=Real(12.0)
        ), 'chiller_return_temp')

        self.add_object(AnalogInputObject(
            objectIdentifier="analog-input,4",
            objectName=f"{name} Power",
            presentValue=Real(85.0)
        ), 'chiller_power')

class AHU(BACnetDevice):
    def __init__(self, device_id, name):
        cov_map = {
            'ahu_supply_temp': 0.2,
            'ahu_return_temp': 0.2,
            'ahu_airflow': 50.0,
            'ahu_cooling_valve': 5.0
        }
        super().__init__(device_id, name, cov_map)

        # Points
        self.add_object(AnalogInputObject(
            objectIdentifier="analog-input,1",
            objectName=f"{name} Supply Temp",
            presentValue=Real(18.0)
        ), 'ahu_supply_temp')

        self.add_object(AnalogInputObject(
            objectIdentifier="analog-input,2",
            objectName=f"{name} Return Temp",
            presentValue=Real(22.0)
        ), 'ahu_return_temp')

        self.add_object(AnalogInputObject(
            objectIdentifier="analog-input,3",
            objectName=f"{name} Supply Air Flow",
            presentValue=Real(5000.0)
        ), 'ahu_airflow')

        self.add_object(BinaryInputObject(
            objectIdentifier="binary-input,4",
            objectName=f"{name} Fan Status",
            presentValue=1
        ), 'ahu_fan_status')

        self.add_object(AnalogInputObject(
            objectIdentifier="analog-input,5",
            objectName=f"{name} Cooling Valve",
            presentValue=Real(45.0)
        ), 'ahu_cooling_valve')

# --- Simulator Main ---
class CondoSimulator:
    def __init__(self):
        self.devices = []
        self.time_of_day = 12
        self.outdoor_temp = 25.0
        self.start_time = datetime.now()

        # Create devices
        self.devices.append(Chiller(1001, "Chiller-1"))
        self.devices.append(AHU(2001, "AHU-1"))
        self.devices.append(AHU(2002, "AHU-2"))

    async def update_simulation(self):
        while True:
            await asyncio.sleep(5)
            # Simple day/night cycle
            self.time_of_day = (self.time_of_day + 0.2) % 24
            hour_offset = (self.time_of_day - 15) / 24 * 2 * math.pi
            self.outdoor_temp = 25.0 + 8.0 * math.sin(hour_offset)

            for device in self.devices:
                for obj_id, info in device.objects.items():
                    obj = info['obj']
                    obj_type = info['type']

                    # Chiller simulation
                    if obj_type == 'chiller_supply_temp':
                        obj.presentValue = Real(7.0 + random.uniform(-0.3, 0.3))
                    elif obj_type == 'chiller_return_temp':
                        obj.presentValue = Real(12.0 + random.uniform(-0.3, 0.3))
                    elif obj_type == 'chiller_power':
                        load_factor = 0.6 + 0.3 * (self.outdoor_temp - 25.0) / 8.0
                        obj.presentValue = Real(85.0 * max(0.3, min(1.0, load_factor)) + random.uniform(-3,3))

                    # AHU simulation
                    elif obj_type == 'ahu_supply_temp':
                        obj.presentValue = Real(18.0 + random.uniform(-1.0, 1.0))
                    elif obj_type == 'ahu_return_temp':
                        obj.presentValue = Real(22.0 + (self.outdoor_temp - 25.0) * 0.2 + random.uniform(-0.5,0.5))
                    elif obj_type == 'ahu_airflow':
                        obj.presentValue = Real(5000.0 + random.uniform(-200,200))
                    elif obj_type == 'ahu_cooling_valve':
                        obj.presentValue = Real(max(0, min(100, 45 + (self.outdoor_temp - 25.0)*2 + random.uniform(-5,5))))
                    elif obj_type == 'ahu_fan_status':
                        obj.presentValue = 1 if random.random() > 0.1 else 0

            # Logging every 30s
            elapsed = (datetime.now() - self.start_time).total_seconds()
            if int(elapsed) % 30 == 0:
                print(f"[{int(self.time_of_day):02d}:{int((self.time_of_day%1)*60):02d}] "
                      f"Outdoor Temp: {self.outdoor_temp:.1f}°C")

    async def run(self):
        print("\nStarting Condo BACnet Simulator with multiple devices...\n")
        await self.update_simulation()

# --- Run ---
if __name__ == "__main__":
    sim = CondoSimulator()
    try:
        asyncio.run(sim.run())
    except KeyboardInterrupt:
        print("\nSimulator stopped by user")