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
from .types import Device

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class OPCUASimulator:
    """Main OPC UA simulator server"""
    
    def __init__(
        self,
        endpoint: str = 'opc.tcp://0.0.0.0:4840',
        profile_name: str = 'factory',
        update_interval: float = 1.0
    ):
        self.endpoint = endpoint
        self.profile_name = profile_name
        self.update_interval = update_interval
        self.server = None
        self.node_manager = None
        self.updater = None
        self.devices: List[Device] = []
    
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
        
        # Get all created devices
        self.devices = self.node_manager.get_all_devices()
        
        # Create metadata nodes for agent discovery
        await self._create_metadata_nodes(profile)
        
        logger.info(f"Node structure created from profile '{self.profile_name}'")
    
    def log_node_structure(self):
        """Log available nodes for user reference"""
        logger.info("=" * 60)
        logger.info("Created device nodes:")
        logger.info("=" * 60)
        
        current_folder = None
        for device in self.devices:
            if device.folder != current_folder:
                current_folder = device.folder
                logger.info(f"\n{device.folder}:")
            
            unit_str = f" ({device.unit})" if device.unit else ""
            range_str = ""
            if device.min_value is not None and device.max_value is not None:
                range_str = f" [{device.min_value}-{device.max_value}]"
            
            logger.info(f"  - {device.name}: {device.device_type}{unit_str}{range_str}")
        
        logger.info("\n" + "=" * 60)
        logger.info(f"Total devices: {len(self.devices)}")
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
        
        device_count = await info_folder.add_variable(2, "DeviceCount", len(self.devices))
        await device_count.set_writable(False)
        
        # Device type summary (count by type)
        device_types = {}
        for device in self.devices:
            device_types[device.device_type] = device_types.get(device.device_type, 0) + 1
        
        device_summary = ", ".join([f"{count} {dtype}" for dtype, count in device_types.items()])
        device_types_node = await info_folder.add_variable(2, "DeviceTypes", device_summary)
        await device_types_node.set_writable(False)
        
        logger.info(f"Created metadata nodes in ServerInfo folder")
    
    async def run(self):
        """Start and run the OPC UA server"""
        await self.init_server()
        await self.create_nodes()
        
        async with self.server:
            logger.info("OPC UA Server started")
            self.log_node_structure()
            
            # Start value updater with device list
            self.updater = ValueUpdater(self.devices, self.update_interval)
            await self.updater.start()


async def main():
    """Main entry point"""
    import sys
    import os
    
    # Parse profile name from environment variable, command line, or default to 'factory'
    profile_name = os.getenv('PROFILE') or (sys.argv[1] if len(sys.argv) > 1 else 'factory')
    
    # Parse port from environment variable or default to 4840
    port = int(os.getenv('PORT', '4840'))
    endpoint = f'opc.tcp://0.0.0.0:{port}'
    
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
    
    logger.info(f"Starting OPC UA simulator on port {port} with profile '{profile_name}'")
    simulator = OPCUASimulator(endpoint=endpoint, profile_name=profile_name)
    await simulator.run()


if __name__ == '__main__':
    asyncio.run(main())
