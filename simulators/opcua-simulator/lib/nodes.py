"""
OPC UA node creation and management
"""
import logging
from typing import Dict, List
from asyncua import Server, ua
from .types import Device
from .models import get_model
from .profiles import DeviceProfile

logger = logging.getLogger(__name__)


class NodeManager:
    """Manages OPC UA node creation and organization"""
    
    def __init__(self, server: Server):
        self.server = server
        self.devices: List[Device] = []
        self._devices_by_key: Dict[str, Device] = {}
        
    async def create_example_node(self):
        """Create simple test variable with string NodeID"""
        objects = self.server.nodes.objects
        my_variable_nodeid = ua.NodeId("MyVariable", 2)  # ns=2;s=MyVariable
        
        # Check if example node already exists (handles Flask debug mode reloads)
        try:
            my_variable = self.server.get_node(my_variable_nodeid)
            await my_variable.read_browse_name()
            logger.debug("Example node already exists, skipping creation")
        except Exception:
            # Node doesn't exist, create it
            my_variable = await objects.add_variable(my_variable_nodeid, "MyVariable", 42.0)
            await my_variable.set_writable()
        
        # Set Description attribute (for discovery and unit extraction)
        try:
            await my_variable.write_attribute(ua.AttributeIds.Description, ua.DataValue(ua.LocalizedText("Example oscillating variable")))
        except Exception as e:
            logger.debug(f"Could not set description: {e}")
        
        # Create device object for example node
        example_device = Device(
            node=my_variable,
            device_type='example',
            model_type='oscillating',
            index=0,
            name='MyVariable',
            folder='root',
            unit=''
        )
        
        self.devices.append(example_device)
        self._devices_by_key['example'] = example_device
        
        logger.info("Created example node: ns=2;s=MyVariable")
        
    async def create_from_profile(self, profile: DeviceProfile):
        """Create nodes from device profile definition"""
        objects = self.server.nodes.objects
        
        # Create main folder (check if exists first)
        main_folder_nodeid = ua.NodeId(profile.name, 2)
        try:
            main_folder = self.server.get_node(main_folder_nodeid)
            await main_folder.read_browse_name()
            logger.info(f"Main folder '{profile.name}' already exists")
        except Exception:
            main_folder = await objects.add_folder(main_folder_nodeid, profile.name)
            logger.info(f"Created main folder: {profile.name}")
        
        folders_created = {}
        total_nodes = 0
        
        for device_group in profile.devices:
            folder_name = device_group['folder']
            model_type = device_group['model']
            prefix = device_group['prefix']
            count = device_group['count']
            unit = device_group.get('unit', '')
            
            # Build folder hierarchy (supports: folder -> subfolder -> zone -> devices)
            current_folder = main_folder
            folder_path = []
            
            # Level 1: Main folder (required)
            if folder_name not in folders_created:
                try:
                    folder = await main_folder.add_folder(2, folder_name)
                    folders_created[folder_name] = folder
                    logger.debug(f"  Created folder: {folder_name}")
                except Exception as e:
                    # Folder already exists, get it
                    folder_nodeid = ua.NodeId(folder_name, 2)
                    folder = self.server.get_node(folder_nodeid)
                    folders_created[folder_name] = folder
                    logger.debug(f"  Folder '{folder_name}' already exists")
            else:
                folder = folders_created[folder_name]
            
            current_folder = folder
            folder_path.append(folder_name)
            
            # Level 2: Subfolder (optional)
            if 'subfolder' in device_group:
                subfolder_name = device_group['subfolder']
                subfolder_key = f"{folder_name}/{subfolder_name}"
                
                if subfolder_key not in folders_created:
                    try:
                        subfolder = await current_folder.add_folder(2, subfolder_name)
                        folders_created[subfolder_key] = subfolder
                        logger.debug(f"    Created subfolder: {subfolder_name}")
                    except Exception:
                        subfolder_nodeid = ua.NodeId(subfolder_name, 2)
                        subfolder = self.server.get_node(subfolder_nodeid)
                        folders_created[subfolder_key] = subfolder
                        logger.debug(f"    Subfolder '{subfolder_name}' already exists")
                else:
                    subfolder = folders_created[subfolder_key]
                
                current_folder = subfolder
                folder_path.append(subfolder_name)
            
            # Level 3: Zone (optional)
            if 'zone' in device_group:
                zone_name = device_group['zone']
                zone_key = f"{'/'.join(folder_path)}/{zone_name}"
                
                if zone_key not in folders_created:
                    try:
                        zone_folder = await current_folder.add_folder(2, zone_name)
                        folders_created[zone_key] = zone_folder
                        logger.debug(f"      Created zone: {zone_name}")
                    except Exception:
                        zone_nodeid = ua.NodeId(zone_name, 2)
                        zone_folder = self.server.get_node(zone_nodeid)
                        folders_created[zone_key] = zone_folder
                        logger.debug(f"      Zone '{zone_name}' already exists")
                else:
                    zone_folder = folders_created[zone_key]
                
                current_folder = zone_folder
                folder_path.append(zone_name)
            
            # Get device config for this group (may override model defaults)
            device_config = device_group.get('config', {})
            
            # Get model instance to extract default min/max
            model = get_model(model_type, device_config)
            
            # Extract min/max from config or model
            min_value = device_config.get('min_value', getattr(model, 'min_value', None))
            max_value = device_config.get('max_value', getattr(model, 'max_value', None))
            
            # Create device nodes in the deepest folder
            for i in range(count):
                node_name = f"{prefix}{i+1}"
                # Create string-based NodeID: ns=2;s=Production/Device1
                # This format is required for agent validation
                node_id_string = f"{folder_path[-1]}/{node_name}"
                node_id = ua.NodeId(node_id_string, 2)
                
                # Check if node already exists (handles Flask debug mode reloads)
                try:
                    node = self.server.get_node(node_id)
                    # Node exists, verify it's accessible
                    await node.read_browse_name()
                    logger.debug(f"Node {node_id_string} already exists, skipping creation")
                except Exception:
                    # Node doesn't exist, create it
                    node = await current_folder.add_variable(node_id, node_name, 0.0)
                    await node.set_writable()
                
                # Set Description attribute with unit information (if available)
                try:
                    if unit:
                        description = f"{device_group.get('description', model_type.replace('_', ' ').title())} in {unit}"
                    else:
                        description = device_group.get('description', model_type.replace('_', ' ').title())
                    await node.write_attribute(ua.AttributeIds.Description, ua.DataValue(ua.LocalizedText(description)))
                except Exception as e:
                    logger.debug(f"Could not set description for {node_name}: {e}")
                
                # Create structured device object
                device = Device(
                    node=node,
                    device_type=model_type,
                    model_type=model_type,
                    index=i,
                    name=node_name,
                    folder='/'.join(folder_path),  # Full path
                    unit=unit,
                    min_value=min_value,
                    max_value=max_value,
                    config=device_config
                )
                
                self.devices.append(device)
                self._devices_by_key[device.key] = device
                total_nodes += 1
        
        logger.info(f"Created {total_nodes} device nodes from profile '{profile.name}'")
        return total_nodes
    
    def get_device(self, key: str) -> Device:
        """Get device by key"""
        return self._devices_by_key.get(key)
    
    def get_all_devices(self) -> List[Device]:
        """Get all managed devices"""
        return self.devices
    
    def get_device_count(self) -> int:
        """Get total number of managed devices"""
        return len(self.devices)
