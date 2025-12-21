"""
OPC UA node creation and management
"""
import logging
from typing import Dict, List
from asyncua import Server, ua
from .types import Sensor
from .models import get_model
from .profiles import SensorProfile

logger = logging.getLogger(__name__)


class NodeManager:
    """Manages OPC UA node creation and organization"""
    
    def __init__(self, server: Server):
        self.server = server
        self.sensors: List[Sensor] = []
        self._sensors_by_key: Dict[str, Sensor] = {}
        
    async def create_example_node(self):
        """Create simple test variable with string NodeID"""
        objects = self.server.nodes.objects
        my_variable_nodeid = ua.NodeId("MyVariable", 2)  # ns=2;s=MyVariable
        my_variable = await objects.add_variable(my_variable_nodeid, "MyVariable", 42.0)
        await my_variable.set_writable()
        
        # Create sensor object for example node
        example_sensor = Sensor(
            node=my_variable,
            sensor_type='example',
            model_type='oscillating',
            index=0,
            name='MyVariable',
            folder='root',
            unit=''
        )
        
        self.sensors.append(example_sensor)
        self._sensors_by_key['example'] = example_sensor
        
        logger.info("Created example node: ns=2;s=MyVariable")
        
    async def create_from_profile(self, profile: SensorProfile):
        """Create nodes from sensor profile definition"""
        objects = self.server.nodes.objects
        
        # Create main folder
        main_folder = await objects.add_folder(2, profile.name)
        logger.info(f"Created main folder: {profile.name}")
        
        folders_created = {}
        total_nodes = 0
        
        for sensor_group in profile.sensors:
            folder_name = sensor_group['folder']
            model_type = sensor_group['model']
            prefix = sensor_group['prefix']
            count = sensor_group['count']
            unit = sensor_group.get('unit', '')
            
            # Create or get folder
            if folder_name not in folders_created:
                folder = await main_folder.add_folder(2, folder_name)
                folders_created[folder_name] = folder
                logger.debug(f"  Created folder: {folder_name}")
            else:
                folder = folders_created[folder_name]
            
            # Get sensor config for this group (may override model defaults)
            sensor_config = sensor_group.get('config', {})
            
            # Get model instance to extract default min/max
            model = get_model(model_type, sensor_config)
            
            # Extract min/max from config or model
            min_value = sensor_config.get('min_value', getattr(model, 'min_value', None))
            max_value = sensor_config.get('max_value', getattr(model, 'max_value', None))
            
            # Create sensor nodes
            for i in range(count):
                node_name = f"{prefix}_{i+1}"
                node = await folder.add_variable(2, node_name, 0.0)
                await node.set_writable()
                
                # Create structured sensor object
                sensor = Sensor(
                    node=node,
                    sensor_type=model_type,
                    model_type=model_type,
                    index=i,
                    name=node_name,
                    folder=folder_name,
                    unit=unit,
                    min_value=min_value,
                    max_value=max_value,
                    config=sensor_config
                )
                
                self.sensors.append(sensor)
                self._sensors_by_key[sensor.key] = sensor
                total_nodes += 1
        
        logger.info(f"Created {total_nodes} sensor nodes from profile '{profile.name}'")
        return total_nodes
    
    def get_sensor(self, key: str) -> Sensor:
        """Get sensor by key"""
        return self._sensors_by_key.get(key)
    
    def get_all_sensors(self) -> List[Sensor]:
        """Get all managed sensors"""
        return self.sensors
    
    def get_sensor_count(self) -> int:
        """Get total number of managed sensors"""
        return len(self.sensors)
