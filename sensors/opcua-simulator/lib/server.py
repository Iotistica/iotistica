"""
OPC UA Server bootstrap and main entry point
"""
import logging
import asyncio
import json
from typing import List
from asyncua import Server, ua
from .nodes import NodeManager
from .updater import ValueUpdater
from .profiles import get_profile_with_api_fallback
from .types import Sensor

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class OPCUASimulator:
    """Main OPC UA simulator server"""
    
    def __init__(
        self,
        endpoint: str = 'opc.tcp://0.0.0.0:4840/iotistic/simulator',
        profile_name: str = 'factory',
        update_interval: float = 1.0
    ):
        self.endpoint = endpoint
        self.profile_name = profile_name
        self.update_interval = update_interval
        self.server = None
        self.node_manager = None
        self.updater = None
        self.sensors: List[Sensor] = []
    
    async def init_server(self):
        """Initialize OPC UA server"""
        self.server = Server()
        await self.server.init()
        self.server.set_endpoint(self.endpoint)
        self.server.set_server_name("Iotistic OPC UA Simulator")
        
        # Set up security (allow anonymous for testing)
        self.server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
        
        logger.info(f"OPC UA server initialized at {self.endpoint}")
    
    async def create_nodes(self):
        """Create node structure from profile"""
        self.node_manager = NodeManager(self.server)
        
        # Create example test node
        await self.node_manager.create_example_node()
        
        # Create nodes from profile (tries API first, falls back to local JSON)
        profile = get_profile_with_api_fallback(self.profile_name)
        await self.node_manager.create_from_profile(profile)
        
        # Get all created sensors
        self.sensors = self.node_manager.get_all_sensors()
        
        # Create metadata nodes for agent discovery
        await self._create_metadata_nodes(profile)
        
        logger.info(f"Node structure created from profile '{self.profile_name}'")
    
    def log_node_structure(self):
        """Log available nodes for user reference"""
        logger.info("=" * 60)
        logger.info("Created sensor nodes:")
        logger.info("=" * 60)
        
        current_folder = None
        for sensor in self.sensors:
            if sensor.folder != current_folder:
                current_folder = sensor.folder
                logger.info(f"\n{sensor.folder}:")
            
            unit_str = f" ({sensor.unit})" if sensor.unit else ""
            range_str = ""
            if sensor.min_value is not None and sensor.max_value is not None:
                range_str = f" [{sensor.min_value}-{sensor.max_value}]"
            
            logger.info(f"  - {sensor.name}: {sensor.sensor_type}{unit_str}{range_str}")
        
        logger.info("\n" + "=" * 60)
        logger.info(f"Total sensors: {len(self.sensors)}")
        logger.info("=" * 60)
    
    async def _create_metadata_nodes(self, profile):
        """Create metadata nodes for agent discovery"""
        objects = self.server.nodes.objects
        
        # Create ServerInfo folder
        info_folder = await objects.add_folder(2, "ServerInfo")
        
        # Profile metadata
        profile_name = await info_folder.add_variable(2, "ProfileName", self.profile_name)
        await profile_name.set_writable(False)
        
        profile_desc = await info_folder.add_variable(2, "ProfileDescription", profile.description)
        await profile_desc.set_writable(False)
        
        sensor_count = await info_folder.add_variable(2, "SensorCount", len(self.sensors))
        await sensor_count.set_writable(False)
        
        # Sensor type summary (count by type)
        sensor_types = {}
        for sensor in self.sensors:
            sensor_types[sensor.sensor_type] = sensor_types.get(sensor.sensor_type, 0) + 1
        
        sensor_summary = ", ".join([f"{count} {stype}" for stype, count in sensor_types.items()])
        sensor_types_node = await info_folder.add_variable(2, "SensorTypes", sensor_summary)
        await sensor_types_node.set_writable(False)
        
        logger.info(f"Created metadata nodes in ServerInfo folder")
    
    async def run(self):
        """Start and run the OPC UA server"""
        await self.init_server()
        await self.create_nodes()
        
        async with self.server:
            logger.info("OPC UA Server started")
            self.log_node_structure()
            
            # Start value updater with sensor list
            self.updater = ValueUpdater(self.sensors, self.update_interval)
            await self.updater.start()


async def main():
    """Main entry point"""
    import sys
    import os
    
    # Parse profile name from environment variable, command line, or default to 'factory'
    profile_name = os.getenv('PROFILE') or (sys.argv[1] if len(sys.argv) > 1 else 'factory')
    
    # Check for state file override (set by web GUI)
    STATE_FILE = "/tmp/opcua_simulator_state.json"
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r") as f:
                state = json.load(f)
                if state.get("profile"):
                    profile_name = state["profile"]
                    logger.info(f"Profile overridden from state file: {profile_name}")
    except Exception as e:
        logger.warning(f"Failed to read state file: {e}")
    
    simulator = OPCUASimulator(profile_name=profile_name)
    await simulator.run()


if __name__ == '__main__':
    asyncio.run(main())
