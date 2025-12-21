"""
OPC UA Server bootstrap and main entry point
"""
import logging
import asyncio
from asyncua import Server, ua
from .nodes import NodeManager
from .updater import ValueUpdater
from .profiles import get_profile

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
        
        # Create nodes from profile
        profile = get_profile(self.profile_name)
        await self.node_manager.create_from_profile(profile)
        
        logger.info(f"Node structure created from profile '{self.profile_name}'")
    
    def log_node_structure(self):
        """Log available nodes for user reference"""
        logger.info("Available node structure:")
        logger.info("  - MyVariable (test variable, oscillates 30-50)")
        
        profile = get_profile(self.profile_name)
        for sensor_group in profile.sensors:
            folder = sensor_group['folder']
            prefix = sensor_group['prefix']
            count = sensor_group['count']
            unit = sensor_group.get('unit', '')
            logger.info(f"  - {profile.name}/{folder}/{prefix}_1-{count} ({unit})")
    
    async def run(self):
        """Start and run the OPC UA server"""
        await self.init_server()
        await self.create_nodes()
        
        async with self.server:
            logger.info("OPC UA Server started")
            self.log_node_structure()
            
            # Start value updater
            self.updater = ValueUpdater(self.node_manager, self.update_interval)
            await self.updater.start()


async def main():
    """Main entry point"""
    import sys
    
    # Parse command line arguments
    profile_name = sys.argv[1] if len(sys.argv) > 1 else 'factory'
    
    simulator = OPCUASimulator(profile_name=profile_name)
    await simulator.run()


if __name__ == '__main__':
    asyncio.run(main())
