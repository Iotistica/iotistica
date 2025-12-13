"""
BACnet Simulator for Condo Building
Simulates typical building automation systems:
- HVAC (Air Handlers, VAV boxes, Thermostats)
- Boilers & Chillers
- Lighting Controls
- Energy Meters
- Access Control (Doors, Gates)
- Elevators
- Fire Alarm Systems
- Water Systems (Pumps, Tanks)
"""

import asyncio
import random
import math
from datetime import datetime
from bacpypes3.local.device import DeviceObject
from bacpypes3.local.analog import AnalogValueObject, AnalogInputObject
from bacpypes3.local.binary import BinaryValueObject, BinaryInputObject
from bacpypes3.local.object import ObjectIdentifier
from bacpypes3.app import Application
from bacpypes3.primitivedata import Real

# Building configuration
BUILDING_NAME = "Riverside Condos"
FLOORS = 12
UNITS_PER_FLOOR = 8
DEVICE_ID = 1234567

class CondoBuildingSimulator:
    def __init__(self):
        self.app = None
        self.objects = {}
        self.start_time = datetime.now()
        
        # Simulation state
        self.outdoor_temp = 25.0  # Celsius
        self.time_of_day = 12  # Hour (0-23)
        
    async def create_device(self):
        """Create BACnet device object"""
        device = DeviceObject(
            objectIdentifier=f"device,{DEVICE_ID}",
            objectName=BUILDING_NAME,
            description="12-Floor Condo Building with 96 Units",
            vendorIdentifier=999,
            vendorName="Iotistic Simulators",
            modelName="Condo Building Simulator v1.0",
        )
        
        # Create BACnet application
        self.app = Application.from_object(device)
        await self.app.startup()
        
        print(f"BACnet Device Created: {BUILDING_NAME}")
        print(f"Device ID: {DEVICE_ID}")
        print(f"IP Address: {self.app.localAddress}")
        
    def create_hvac_system(self):
        """Create HVAC system objects for the building"""
        object_id = 1000
        
        # Main Air Handling Units (AHUs) - 3 units serving 4 floors each
        for ahu_num in range(1, 4):
            floors_served = f"{(ahu_num-1)*4 + 1}-{ahu_num*4}"
            
            # Supply Air Temperature
            obj = AnalogInputObject(
                objectIdentifier=f"analog-input,{object_id}",
                objectName=f"AHU-{ahu_num} Supply Air Temp",
                description=f"Supply air temperature for floors {floors_served}",
                presentValue=Real(18.0 + random.uniform(-1, 1)),
                units="degreesCelsius",
            )
            self.objects[object_id] = {'obj': obj, 'type': 'ahu_supply_temp', 'ahu': ahu_num}
            object_id += 1
            
            # Return Air Temperature
            obj = AnalogInputObject(
                objectIdentifier=f"analog-input,{object_id}",
                objectName=f"AHU-{ahu_num} Return Air Temp",
                description=f"Return air temperature for floors {floors_served}",
                presentValue=Real(22.0 + random.uniform(-1, 1)),
                units="degreesCelsius",
            )
            self.objects[object_id] = {'obj': obj, 'type': 'ahu_return_temp', 'ahu': ahu_num}
            object_id += 1
            
            # Supply Air Flow
            obj = AnalogInputObject(
                objectIdentifier=f"analog-input,{object_id}",
                objectName=f"AHU-{ahu_num} Supply Air Flow",
                description=f"Supply air flow rate for floors {floors_served}",
                presentValue=Real(5000.0 + random.uniform(-200, 200)),
                units="cubicFeetPerMinute",
            )
            self.objects[object_id] = {'obj': obj, 'type': 'ahu_airflow', 'ahu': ahu_num}
            object_id += 1
            
            # Fan Status
            obj = BinaryInputObject(
                objectIdentifier=f"binary-input,{object_id}",
                objectName=f"AHU-{ahu_num} Fan Status",
                description=f"Supply fan running status for floors {floors_served}",
                presentValue=1,  # 1 = running, 0 = stopped
            )
            self.objects[object_id] = {'obj': obj, 'type': 'ahu_fan_status', 'ahu': ahu_num}
            object_id += 1
            
            # Cooling Valve Position
            obj = AnalogInputObject(
                objectIdentifier=f"analog-input,{object_id}",
                objectName=f"AHU-{ahu_num} Cooling Valve",
                description=f"Cooling coil valve position for floors {floors_served}",
                presentValue=Real(45.0 + random.uniform(-10, 10)),
                units="percent",
            )
            self.objects[object_id] = {'obj': obj, 'type': 'ahu_cooling_valve', 'ahu': ahu_num}
            object_id += 1
        
        # VAV Boxes - 2 per floor (corridor + units)
        for floor in range(1, FLOORS + 1):
            for zone in ['A', 'B']:
                # Zone Temperature
                obj = AnalogInputObject(
                    objectIdentifier=f"analog-input,{object_id}",
                    objectName=f"Floor-{floor} Zone-{zone} Temp",
                    description=f"Zone temperature for Floor {floor} Zone {zone}",
                    presentValue=Real(22.0 + random.uniform(-1.5, 1.5)),
                    units="degreesCelsius",
                )
                self.objects[object_id] = {'obj': obj, 'type': 'vav_temp', 'floor': floor, 'zone': zone}
                object_id += 1
                
                # Damper Position
                obj = AnalogInputObject(
                    objectIdentifier=f"analog-input,{object_id}",
                    objectName=f"Floor-{floor} Zone-{zone} Damper",
                    description=f"VAV damper position for Floor {floor} Zone {zone}",
                    presentValue=Real(50.0 + random.uniform(-15, 15)),
                    units="percent",
                )
                self.objects[object_id] = {'obj': obj, 'type': 'vav_damper', 'floor': floor, 'zone': zone}
                object_id += 1
        
        print(f"Created HVAC system: 3 AHUs, {FLOORS * 2} VAV boxes")
        
    def create_boiler_chiller_system(self):
        """Create heating/cooling plant equipment"""
        object_id = 2000
        
        # Chiller (for cooling)
        obj = BinaryInputObject(
            objectIdentifier=f"binary-input,{object_id}",
            objectName="Chiller-1 Status",
            description="Main chiller running status",
            presentValue=1,
        )
        self.objects[object_id] = {'obj': obj, 'type': 'chiller_status'}
        object_id += 1
        
        obj = AnalogInputObject(
            objectIdentifier=f"analog-input,{object_id}",
            objectName="Chiller-1 Supply Temp",
            description="Chilled water supply temperature",
            presentValue=Real(7.0 + random.uniform(-0.5, 0.5)),
            units="degreesCelsius",
        )
        self.objects[object_id] = {'obj': obj, 'type': 'chiller_supply_temp'}
        object_id += 1
        
        obj = AnalogInputObject(
            objectIdentifier=f"analog-input,{object_id}",
            objectName="Chiller-1 Return Temp",
            description="Chilled water return temperature",
            presentValue=Real(12.0 + random.uniform(-0.5, 0.5)),
            units="degreesCelsius",
        )
        self.objects[object_id] = {'obj': obj, 'type': 'chiller_return_temp'}
        object_id += 1
        
        obj = AnalogInputObject(
            objectIdentifier=f"analog-input,{object_id}",
            objectName="Chiller-1 Power",
            description="Chiller electrical consumption",
            presentValue=Real(85.0 + random.uniform(-5, 5)),
            units="kilowatts",
        )
        self.objects[object_id] = {'obj': obj, 'type': 'chiller_power'}
        object_id += 1
        
        # Boilers (for heating) - 2 units
        for boiler_num in range(1, 3):
            obj = BinaryInputObject(
                objectIdentifier=f"binary-input,{object_id}",
                objectName=f"Boiler-{boiler_num} Status",
                description=f"Boiler {boiler_num} firing status",
                presentValue=0,  # Off during summer
            )
            self.objects[object_id] = {'obj': obj, 'type': 'boiler_status', 'boiler': boiler_num}
            object_id += 1
            
            obj = AnalogInputObject(
                objectIdentifier=f"analog-input,{object_id}",
                objectName=f"Boiler-{boiler_num} Supply Temp",
                description=f"Hot water supply temperature from Boiler {boiler_num}",
                presentValue=Real(60.0 + random.uniform(-2, 2)),
                units="degreesCelsius",
            )
            self.objects[object_id] = {'obj': obj, 'type': 'boiler_supply_temp', 'boiler': boiler_num}
            object_id += 1
            
            obj = AnalogInputObject(
                objectIdentifier=f"analog-input,{object_id}",
                objectName=f"Boiler-{boiler_num} Gas Flow",
                description=f"Natural gas consumption for Boiler {boiler_num}",
                presentValue=Real(0.0),  # Off
                units="cubicMetersPerHour",
            )
            self.objects[object_id] = {'obj': obj, 'type': 'boiler_gas_flow', 'boiler': boiler_num}
            object_id += 1
        
        print(f"Created plant equipment: 1 Chiller, 2 Boilers")
        
    def create_energy_meters(self):
        """Create electrical and gas meters"""
        object_id = 3000
        
        # Main electrical meter
        obj = AnalogInputObject(
            objectIdentifier=f"analog-input,{object_id}",
            objectName="Building Main Power",
            description="Total building electrical demand",
            presentValue=Real(250.0 + random.uniform(-20, 20)),
            units="kilowatts",
        )
        self.objects[object_id] = {'obj': obj, 'type': 'main_power'}
        object_id += 1
        
        obj = AnalogInputObject(
            objectIdentifier=f"analog-input,{object_id}",
            objectName="Building Total Energy",
            description="Cumulative electrical energy consumption",
            presentValue=Real(1567890.0),
            units="kilowattHours",
        )
        self.objects[object_id] = {'obj': obj, 'type': 'total_energy'}
        object_id += 1
        
        # Sub-meters per floor
        for floor in range(1, FLOORS + 1):
            obj = AnalogInputObject(
                objectIdentifier=f"analog-input,{object_id}",
                objectName=f"Floor-{floor} Power",
                description=f"Electrical demand for Floor {floor}",
                presentValue=Real(18.0 + random.uniform(-3, 3)),
                units="kilowatts",
            )
            self.objects[object_id] = {'obj': obj, 'type': 'floor_power', 'floor': floor}
            object_id += 1
        
        # Natural gas meter
        obj = AnalogInputObject(
            objectIdentifier=f"analog-input,{object_id}",
            objectName="Building Gas Flow",
            description="Natural gas consumption (heating/hot water)",
            presentValue=Real(12.0 + random.uniform(-2, 2)),
            units="cubicMetersPerHour",
        )
        self.objects[object_id] = {'obj': obj, 'type': 'gas_flow'}
        object_id += 1
        
        print(f"Created energy meters: 1 main + {FLOORS} floor sub-meters + 1 gas meter")
        
    def create_lighting_controls(self):
        """Create lighting control objects"""
        object_id = 4000
        
        # Common area lighting per floor
        for floor in range(1, FLOORS + 1):
            # Corridor lighting
            obj = BinaryInputObject(
                objectIdentifier=f"binary-input,{object_id}",
                objectName=f"Floor-{floor} Corridor Lights",
                description=f"Corridor lighting status for Floor {floor}",
                presentValue=1,  # On during day
            )
            self.objects[object_id] = {'obj': obj, 'type': 'corridor_lights', 'floor': floor}
            object_id += 1
            
            # Stairwell lighting
            obj = BinaryInputObject(
                objectIdentifier=f"binary-input,{object_id}",
                objectName=f"Floor-{floor} Stairwell Lights",
                description=f"Stairwell lighting status for Floor {floor}",
                presentValue=1,
            )
            self.objects[object_id] = {'obj': obj, 'type': 'stairwell_lights', 'floor': floor}
            object_id += 1
        
        # Exterior lighting
        obj = BinaryInputObject(
            objectIdentifier=f"binary-input,{object_id}",
            objectName="Exterior Facade Lights",
            description="Building exterior facade lighting",
            presentValue=0,  # Off during day
        )
        self.objects[object_id] = {'obj': obj, 'type': 'facade_lights'}
        object_id += 1
        
        obj = BinaryInputObject(
            objectIdentifier=f"binary-input,{object_id}",
            objectName="Parking Lot Lights",
            description="Parking area lighting",
            presentValue=0,  # Off during day
        )
        self.objects[object_id] = {'obj': obj, 'type': 'parking_lights'}
        object_id += 1
        
        print(f"Created lighting controls: {FLOORS * 2} common area + 2 exterior")
        
    def create_access_control(self):
        """Create access control objects"""
        object_id = 5000
        
        # Main entrance
        obj = BinaryInputObject(
            objectIdentifier=f"binary-input,{object_id}",
            objectName="Main Entrance Door",
            description="Main entrance door status (0=closed, 1=open)",
            presentValue=0,
        )
        self.objects[object_id] = {'obj': obj, 'type': 'main_door'}
        object_id += 1
        
        # Parking gate
        obj = BinaryInputObject(
            objectIdentifier=f"binary-input,{object_id}",
            objectName="Parking Gate",
            description="Parking gate status (0=closed, 1=open)",
            presentValue=0,
        )
        self.objects[object_id] = {'obj': obj, 'type': 'parking_gate'}
        object_id += 1
        
        # Garage door
        obj = BinaryInputObject(
            objectIdentifier=f"binary-input,{object_id}",
            objectName="Underground Garage Door",
            description="Underground garage vehicle door",
            presentValue=0,
        )
        self.objects[object_id] = {'obj': obj, 'type': 'garage_door'}
        object_id += 1
        
        print(f"Created access control: 3 entry points")
        
    def create_elevators(self):
        """Create elevator monitoring objects"""
        object_id = 6000
        
        # 2 Elevators
        for elevator_num in range(1, 3):
            # Current floor
            obj = AnalogInputObject(
                objectIdentifier=f"analog-input,{object_id}",
                objectName=f"Elevator-{elevator_num} Floor",
                description=f"Current floor position of Elevator {elevator_num}",
                presentValue=Real(1.0),
                units="noUnits",
            )
            self.objects[object_id] = {'obj': obj, 'type': 'elevator_floor', 'elevator': elevator_num}
            object_id += 1
            
            # Running status
            obj = BinaryInputObject(
                objectIdentifier=f"binary-input,{object_id}",
                objectName=f"Elevator-{elevator_num} Running",
                description=f"Elevator {elevator_num} motor running status",
                presentValue=0,
            )
            self.objects[object_id] = {'obj': obj, 'type': 'elevator_running', 'elevator': elevator_num}
            object_id += 1
            
            # Door status
            obj = BinaryInputObject(
                objectIdentifier=f"binary-input,{object_id}",
                objectName=f"Elevator-{elevator_num} Door",
                description=f"Elevator {elevator_num} door status (0=closed, 1=open)",
                presentValue=0,
            )
            self.objects[object_id] = {'obj': obj, 'type': 'elevator_door', 'elevator': elevator_num}
            object_id += 1
        
        print(f"Created elevator monitoring: 2 elevators")
        
    def create_water_system(self):
        """Create water system monitoring"""
        object_id = 7000
        
        # Domestic water supply
        obj = AnalogInputObject(
            objectIdentifier=f"analog-input,{object_id}",
            objectName="Domestic Water Pressure",
            description="Main domestic water supply pressure",
            presentValue=Real(450.0 + random.uniform(-20, 20)),
            units="kiloPascals",
        )
        self.objects[object_id] = {'obj': obj, 'type': 'water_pressure'}
        object_id += 1
        
        obj = AnalogInputObject(
            objectIdentifier=f"analog-input,{object_id}",
            objectName="Domestic Water Flow",
            description="Main domestic water flow rate",
            presentValue=Real(45.0 + random.uniform(-10, 10)),
            units="litersPerMinute",
        )
        self.objects[object_id] = {'obj': obj, 'type': 'water_flow'}
        object_id += 1
        
        # Hot water system
        obj = AnalogInputObject(
            objectIdentifier=f"analog-input,{object_id}",
            objectName="Hot Water Tank Temp",
            description="Domestic hot water storage tank temperature",
            presentValue=Real(55.0 + random.uniform(-2, 2)),
            units="degreesCelsius",
        )
        self.objects[object_id] = {'obj': obj, 'type': 'hot_water_temp'}
        object_id += 1
        
        # Sump pumps
        for pump_num in range(1, 3):
            obj = BinaryInputObject(
                objectIdentifier=f"binary-input,{object_id}",
                objectName=f"Sump Pump-{pump_num} Status",
                description=f"Basement sump pump {pump_num} running status",
                presentValue=0,
            )
            self.objects[object_id] = {'obj': obj, 'type': 'sump_pump_status', 'pump': pump_num}
            object_id += 1
        
        print(f"Created water system: pressure/flow monitoring, hot water, 2 sump pumps")
        
    def create_fire_alarm(self):
        """Create fire alarm system objects"""
        object_id = 8000
        
        # Fire alarm panel
        obj = BinaryInputObject(
            objectIdentifier=f"binary-input,{object_id}",
            objectName="Fire Alarm Panel Status",
            description="Fire alarm system normal/alarm status",
            presentValue=0,  # 0=normal, 1=alarm
        )
        self.objects[object_id] = {'obj': obj, 'type': 'fire_alarm_status'}
        object_id += 1
        
        obj = BinaryInputObject(
            objectIdentifier=f"binary-input,{object_id}",
            objectName="Fire Alarm Panel Trouble",
            description="Fire alarm system trouble condition",
            presentValue=0,
        )
        self.objects[object_id] = {'obj': obj, 'type': 'fire_alarm_trouble'}
        object_id += 1
        
        # Smoke detectors per floor
        for floor in range(1, FLOORS + 1):
            obj = BinaryInputObject(
                objectIdentifier=f"binary-input,{object_id}",
                objectName=f"Floor-{floor} Smoke Detector",
                description=f"Corridor smoke detector for Floor {floor}",
                presentValue=0,
            )
            self.objects[object_id] = {'obj': obj, 'type': 'smoke_detector', 'floor': floor}
            object_id += 1
        
        print(f"Created fire alarm: 1 panel + {FLOORS} smoke detectors")
        
    async def update_simulation(self):
        """Update all simulated values periodically"""
        while True:
            await asyncio.sleep(5)
            
            # Update time of day (cycles through 24 hours every 2 minutes)
            self.time_of_day = (self.time_of_day + 0.2) % 24
            
            # Simulate outdoor temperature based on time of day
            # Warmest at 3pm (15:00), coolest at 3am (3:00)
            hour_offset = (self.time_of_day - 15) / 24 * 2 * math.pi
            self.outdoor_temp = 25.0 + 8.0 * math.sin(hour_offset)
            
            # Simulate occupancy (higher during evening/morning, lower at night)
            occupancy_factor = 0.3
            if 7 <= self.time_of_day < 9 or 17 <= self.time_of_day < 23:
                occupancy_factor = 0.8
            elif 9 <= self.time_of_day < 17:
                occupancy_factor = 0.2
            
            # Update HVAC values
            for obj_id, obj_info in self.objects.items():
                obj = obj_info['obj']
                obj_type = obj_info['type']
                
                # HVAC temperatures
                if obj_type == 'ahu_supply_temp':
                    # Supply air stays cool for cooling
                    new_val = 18.0 + random.uniform(-0.8, 0.8)
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'ahu_return_temp':
                    # Return air affected by outdoor temp and occupancy
                    new_val = 22.0 + (self.outdoor_temp - 25.0) * 0.2 + occupancy_factor * 1.5 + random.uniform(-0.5, 0.5)
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'ahu_airflow':
                    # Airflow varies with occupancy
                    base_flow = 5000.0
                    new_val = base_flow * (0.6 + 0.4 * occupancy_factor) + random.uniform(-100, 100)
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'ahu_cooling_valve':
                    # Cooling valve opens more when outdoor temp is high
                    base_valve = 30.0 + (self.outdoor_temp - 25.0) * 2.0
                    new_val = max(0, min(100, base_valve + random.uniform(-5, 5)))
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'vav_temp':
                    # Zone temps vary slightly
                    new_val = 22.0 + (self.outdoor_temp - 25.0) * 0.15 + random.uniform(-1.2, 1.2)
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'vav_damper':
                    # Dampers modulate with zone load
                    new_val = 50.0 + (self.outdoor_temp - 25.0) + random.uniform(-10, 10)
                    obj.presentValue = Real(max(15, min(95, new_val)))
                    
                # Chiller
                elif obj_type == 'chiller_supply_temp':
                    new_val = 7.0 + random.uniform(-0.3, 0.3)
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'chiller_return_temp':
                    new_val = 12.0 + random.uniform(-0.3, 0.3)
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'chiller_power':
                    # Power varies with load
                    load_factor = 0.6 + 0.3 * (self.outdoor_temp - 25.0) / 8.0 + 0.1 * occupancy_factor
                    new_val = 85.0 * max(0.3, min(1.0, load_factor)) + random.uniform(-3, 3)
                    obj.presentValue = Real(new_val)
                    
                # Energy meters
                elif obj_type == 'main_power':
                    # Building power varies with time and occupancy
                    base_power = 150.0  # Base load (always-on systems)
                    hvac_power = 80.0 * (0.5 + 0.5 * (self.outdoor_temp - 20.0) / 10.0)
                    occupancy_power = 50.0 * occupancy_factor
                    new_val = base_power + hvac_power + occupancy_power + random.uniform(-15, 15)
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'total_energy':
                    # Increment energy counter (5s interval = 0.00139 hours)
                    current_power = next((o['obj'].presentValue for oid, o in self.objects.items() if o['type'] == 'main_power'), 250.0)
                    increment = current_power * 0.00139  # kWh
                    obj.presentValue = Real(obj.presentValue + increment)
                    
                elif obj_type == 'floor_power':
                    # Each floor gets a fraction of total power
                    new_val = 18.0 * (0.7 + 0.3 * occupancy_factor) + random.uniform(-2, 2)
                    obj.presentValue = Real(new_val)
                    
                # Lighting
                elif obj_type in ['corridor_lights', 'stairwell_lights']:
                    # Always on during day, occupancy-based at night
                    if 6 <= self.time_of_day < 22:
                        obj.presentValue = 1
                    else:
                        obj.presentValue = 1 if random.random() < 0.3 else 0
                        
                elif obj_type in ['facade_lights', 'parking_lights']:
                    # On at night, off during day
                    obj.presentValue = 1 if (self.time_of_day < 6 or self.time_of_day >= 20) else 0
                    
                # Doors/gates - random activity
                elif obj_type in ['main_door', 'parking_gate', 'garage_door']:
                    # Occasional opening (higher during peak hours)
                    activity_rate = 0.05 if 7 <= self.time_of_day < 9 or 17 <= self.time_of_day < 19 else 0.01
                    obj.presentValue = 1 if random.random() < activity_rate else 0
                    
                # Elevators - simulate movement
                elif obj_type == 'elevator_floor':
                    # Random floor selection
                    if random.random() < 0.3:
                        new_floor = random.randint(1, FLOORS)
                        obj.presentValue = Real(new_floor)
                        
                elif obj_type == 'elevator_running':
                    # Running when changing floors
                    elevator_num = obj_info.get('elevator')
                    if elevator_num and random.random() < 0.25:
                        obj.presentValue = 1 if random.random() < 0.5 else 0
                        
                elif obj_type == 'elevator_door':
                    # Doors open when stopped
                    elevator_num = obj_info.get('elevator')
                    running_obj = next((o['obj'] for oid, o in self.objects.items() 
                                       if o['type'] == 'elevator_running' and o.get('elevator') == elevator_num), None)
                    if running_obj:
                        obj.presentValue = 0 if running_obj.presentValue == 1 else (1 if random.random() < 0.3 else 0)
                        
                # Water system
                elif obj_type == 'water_pressure':
                    # Pressure fluctuates with usage
                    new_val = 450.0 - 30.0 * occupancy_factor + random.uniform(-15, 15)
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'water_flow':
                    # Flow increases with occupancy
                    new_val = 30.0 * occupancy_factor + random.uniform(-5, 5)
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'hot_water_temp':
                    new_val = 55.0 + random.uniform(-1.5, 1.5)
                    obj.presentValue = Real(new_val)
                    
                elif obj_type == 'sump_pump_status':
                    # Pumps run occasionally
                    obj.presentValue = 1 if random.random() < 0.02 else 0
            
            # Log status every 30 seconds
            elapsed = (datetime.now() - self.start_time).total_seconds()
            if int(elapsed) % 30 == 0:
                power = next((o['obj'].presentValue for oid, o in self.objects.items() if o['type'] == 'main_power'), 0)
                outdoor = self.outdoor_temp
                time_str = f"{int(self.time_of_day):02d}:{int((self.time_of_day % 1) * 60):02d}"
                print(f"[{time_str}] Outdoor: {outdoor:.1f}°C, Building Power: {power:.1f} kW, Objects: {len(self.objects)}")
    
    async def run(self):
        """Start the BACnet simulator"""
        print(f"\n{'='*60}")
        print(f"Starting {BUILDING_NAME} BACnet Simulator")
        print(f"{'='*60}\n")
        
        await self.create_device()
        
        print("\nCreating building systems...")
        self.create_hvac_system()
        self.create_boiler_chiller_system()
        self.create_energy_meters()
        self.create_lighting_controls()
        self.create_access_control()
        self.create_elevators()
        self.create_water_system()
        self.create_fire_alarm()
        
        print(f"\n{'='*60}")
        print(f"Total BACnet Objects: {len(self.objects)}")
        print(f"Building Details:")
        print(f"  - Floors: {FLOORS}")
        print(f"  - Units: {FLOORS * UNITS_PER_FLOOR}")
        print(f"  - AHUs: 3")
        print(f"  - VAV Boxes: {FLOORS * 2}")
        print(f"  - Elevators: 2")
        print(f"{'='*60}\n")
        
        # Add objects to BACnet application
        for obj_id, obj_info in self.objects.items():
            self.app.add_object(obj_info['obj'])
        
        print(f"BACnet device running on {self.app.localAddress}")
        print("Starting simulation updates...\n")
        
        # Start simulation update loop
        await self.update_simulation()

async def main():
    simulator = CondoBuildingSimulator()
    await simulator.run()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\nSimulator stopped by user")
