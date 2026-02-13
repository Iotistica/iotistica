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
        
        # Set Description attribute (for discovery and unit extraction)
        try:
            await my_variable.write_attribute(ua.AttributeIds.Description, ua.DataValue(ua.LocalizedText("Example oscillating variable")))
        except Exception as e:
            logger.debug(f"Could not set description: {e}")
        
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
            
            # Build folder hierarchy (supports: folder -> subfolder -> zone -> sensors)
            current_folder = main_folder
            folder_path = []
            
            # Level 1: Main folder (required)
            if folder_name not in folders_created:
                folder = await main_folder.add_folder(2, folder_name)
                folders_created[folder_name] = folder
                logger.debug(f"  Created folder: {folder_name}")
            else:
                folder = folders_created[folder_name]
            
            current_folder = folder
            folder_path.append(folder_name)
            
            # Level 2: Subfolder (optional)
            if 'subfolder' in sensor_group:
                subfolder_name = sensor_group['subfolder']
                subfolder_key = f"{folder_name}/{subfolder_name}"
                
                if subfolder_key not in folders_created:
                    subfolder = await current_folder.add_folder(2, subfolder_name)
                    folders_created[subfolder_key] = subfolder
                    logger.debug(f"    Created subfolder: {subfolder_name}")
                else:
                    subfolder = folders_created[subfolder_key]
                
                current_folder = subfolder
                folder_path.append(subfolder_name)
            
            # Level 3: Zone (optional)
            if 'zone' in sensor_group:
                zone_name = sensor_group['zone']
                zone_key = f"{'/'.join(folder_path)}/{zone_name}"
                
                if zone_key not in folders_created:
                    zone_folder = await current_folder.add_folder(2, zone_name)
                    folders_created[zone_key] = zone_folder
                    logger.debug(f"      Created zone: {zone_name}")
                else:
                    zone_folder = folders_created[zone_key]
                
                current_folder = zone_folder
                folder_path.append(zone_name)
            
            # Get sensor config for this group (may override model defaults)
            sensor_config = sensor_group.get('config', {})
            
            # Get model instance to extract default min/max
            model = get_model(model_type, sensor_config)
            
            # Extract min/max from config or model
            min_value = sensor_config.get('min_value', getattr(model, 'min_value', None))
            max_value = sensor_config.get('max_value', getattr(model, 'max_value', None))
            
            # Create sensor nodes in the deepest folder
            for i in range(count):
                node_name = f"{prefix}{i+1}"
                # Create string-based NodeID: ns=2;s=Production/Sensor1
                # This format is required for agent validation
                node_id_string = f"{folder_path[-1]}/{node_name}"
                node_id = ua.NodeId(node_id_string, 2)
                node = await current_folder.add_variable(node_id, node_name, 0.0)
                await node.set_writable()
                
                # Set Description attribute with unit information (if available)
                try:
                    if unit:
                        description = f"{sensor_group.get('description', model_type.replace('_', ' ').title())} in {unit}"
                    else:
                        description = sensor_group.get('description', model_type.replace('_', ' ').title())
                    await node.write_attribute(ua.AttributeIds.Description, ua.DataValue(ua.LocalizedText(description)))
                except Exception as e:
                    logger.debug(f"Could not set description for {node_name}: {e}")
                
                # Create structured sensor object
                sensor = Sensor(
                    node=node,
                    sensor_type=model_type,
                    model_type=model_type,
                    index=i,
                    name=node_name,
                    folder='/'.join(folder_path),  # Full path
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
