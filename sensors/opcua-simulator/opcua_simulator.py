#!/usr/bin/env python3
"""
OPC UA Simulator for Iotistic Platform
Simulates industrial OPC UA server with realistic sensor data
"""
import logging
import asyncio
import time
import random
import math
from asyncua import Server, ua

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class OPCUASimulator:
    """Simulates OPC UA server with industrial sensor nodes"""
    
    def __init__(self, endpoint='opc.tcp://0.0.0.0:4840/iotistic/simulator'):
        self.endpoint = endpoint
        self.server = None
        self.nodes = {}
        self.start_time = time.time()
    
    async def init_server(self):
        """Initialize OPC UA server with node structure"""
        self.server = Server()
        await self.server.init()
        self.server.set_endpoint(self.endpoint)
        self.server.set_server_name("Iotistic OPC UA Simulator")
        
        # Set up security (allow anonymous for testing)
        self.server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
        
        # Get objects node
        objects = self.server.nodes.objects
        
        # Create main folder
        factory = await objects.add_folder(2, "Factory")
        
        # Add simple example variable with explicit string NodeID (for easy testing)
        my_variable_nodeid = ua.NodeId("MyVariable", 2)  # ns=2;s=MyVariable
        my_variable = await objects.add_variable(my_variable_nodeid, "MyVariable", 42.0)
        await my_variable.set_writable()
        self.nodes['example'] = my_variable
        
        # Create sensor groups
        temperature_folder = await factory.add_folder(2, "Temperature")
        pressure_folder = await factory.add_folder(2, "Pressure")
        flow_folder = await factory.add_folder(2, "Flow")
        level_folder = await factory.add_folder(2, "Level")
        vibration_folder = await factory.add_folder(2, "Vibration")
        power_folder = await factory.add_folder(2, "Power")
        
        # Temperature sensors
        for i in range(5):
            node = await temperature_folder.add_variable(2, f"Sensor_{i+1}", 25.0)
            await node.set_writable()
            self.nodes[f"temp_{i}"] = node
        
        # Pressure sensors
        for i in range(5):
            node = await pressure_folder.add_variable(2, f"Sensor_{i+1}", 1100.0)
            await node.set_writable()
            self.nodes[f"pressure_{i}"] = node
        
        # Flow sensors
        for i in range(5):
            node = await flow_folder.add_variable(2, f"Sensor_{i+1}", 50.0)
            await node.set_writable()
            self.nodes[f"flow_{i}"] = node
        
        # Level sensors
        for i in range(3):
            node = await level_folder.add_variable(2, f"Tank_{i+1}", 500.0)
            await node.set_writable()
            self.nodes[f"level_{i}"] = node
        
        # Vibration sensors
        for i in range(4):
            node = await vibration_folder.add_variable(2, f"Motor_{i+1}", 20.0)
            await node.set_writable()
            self.nodes[f"vibration_{i}"] = node
        
        # Power sensors
        for i in range(3):
            node = await power_folder.add_variable(2, f"Line_{i+1}", 5000.0)
            await node.set_writable()
            self.nodes[f"power_{i}"] = node
        
        logger.info(f"Created {len(self.nodes)} sensor nodes")
    
    def generate_value(self, sensor_type, index):
        """Generate realistic sensor value"""
        elapsed = time.time() - self.start_time
        
        if sensor_type == 'temp':
            # Temperature: 20-30°C
            base = 25.0
            variation = 5.0 * math.sin(elapsed / 30.0 + index * 0.5)
            noise = random.uniform(-0.5, 0.5)
            return round(base + variation + noise, 2)
        
        elif sensor_type == 'pressure':
            # Pressure: 1000-1200 mbar
            base = 1100.0
            variation = 50.0 * math.sin(elapsed / 45.0 + index * 0.3)
            noise = random.uniform(-5.0, 5.0)
            return round(base + variation + noise, 1)
        
        elif sensor_type == 'flow':
            # Flow: 0-100 L/min
            base = 50.0
            variation = 30.0 * math.sin(elapsed / 20.0 + index * 0.7)
            noise = random.uniform(-2.0, 2.0)
            return round(max(0.0, base + variation + noise), 1)
        
        elif sensor_type == 'level':
            # Level: 0-1000 mm
            base = 500.0
            variation = 200.0 * math.sin(elapsed / 40.0 + index * 0.6)
            noise = random.uniform(-10.0, 10.0)
            return round(max(0.0, min(1000.0, base + variation + noise)), 1)
        
        elif sensor_type == 'vibration':
            # Vibration: 0-100 mm/s
            base = 20.0
            variation = 15.0 * math.sin(elapsed / 10.0 + index * 1.2)
            spike = 30.0 if random.random() < 0.05 else 0.0  # Occasional spikes
            noise = random.uniform(-2.0, 2.0)
            return round(max(0.0, base + variation + spike + noise), 2)
        
        elif sensor_type == 'power':
            # Power: 0-10000 W
            base = 5000.0
            variation = 2000.0 * math.sin(elapsed / 25.0 + index * 0.8)
            noise = random.uniform(-50.0, 50.0)
            return round(max(0.0, base + variation + noise), 1)
        
        return 0.0
    
    async def update_values(self):
        """Update all sensor values periodically"""
        while True:
            try:
                for key, node in self.nodes.items():
                    # Handle example variable separately
                    if key == 'example':
                        # Oscillating value between 30 and 50
                        elapsed = time.time() - self.start_time
                        value = 40.0 + 10.0 * math.sin(elapsed / 5.0)
                        await node.write_value(round(value, 2))
                        continue
                    
                    # Parse sensor type and index from key
                    parts = key.rsplit('_', 1)
                    sensor_type = parts[0]
                    index = int(parts[1])
                    
                    # Generate and update value
                    value = self.generate_value(sensor_type, index)
                    await node.write_value(value)
                
                await asyncio.sleep(1.0)  # Update every second
                
            except Exception as e:
                logger.error(f"Error updating values: {e}")
                await asyncio.sleep(1.0)
    
    async def run(self):
        """Start and run the OPC UA server"""
        await self.init_server()
        
        async with self.server:
            logger.info(f"OPC UA Server started at {self.endpoint}")
            logger.info("Available node structure:")
            logger.info("  - MyVariable (test variable, oscillates 30-50)")
            logger.info("  - Factory/Temperature/Sensor_1-5 (°C)")
            logger.info("  - Factory/Pressure/Sensor_1-5 (mbar)")
            logger.info("  - Factory/Flow/Sensor_1-5 (L/min)")
            logger.info("  - Factory/Level/Tank_1-3 (mm)")
            logger.info("  - Factory/Vibration/Motor_1-4 (mm/s)")
            logger.info("  - Factory/Power/Line_1-3 (W)")
            
            # Start value update task
            await self.update_values()


async def main():
    simulator = OPCUASimulator()
    await simulator.run()


if __name__ == '__main__':
    asyncio.run(main())
