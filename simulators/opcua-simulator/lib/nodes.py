"""
OPC UA node creation and management
"""
import logging
import uuid as uuid_module
from typing import Dict, List
from asyncua import Server, ua
from .types import Device
from .models import get_model
from .profiles import DeviceProfile

logger = logging.getLogger(__name__)

# Fixed namespace for deterministic per-device UUID generation (uuid5)
_DEVICE_UUID_NAMESPACE = uuid_module.UUID('b5a7b3c9-d1e2-4f3a-8960-c0d1e2f34567')


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
            
            # Get device config for this group
            device_config = device_group.get('config', {})
            
            # Get model instance to extract default min/max
            model = get_model(model_type, device_config)
            
            # Extract min/max from config or model
            min_value = device_config.get('min_value', getattr(model, 'min_value', None))
            max_value = device_config.get('max_value', getattr(model, 'max_value', None))
            
            # Create device nodes — each device is an object folder with DeviceUUID + value child
            for i in range(count):
                node_name = f"{prefix}{i+1}"
                # NodeID for the device object: ns=2;s=Temperature/Device1
                node_id_string = f"{folder_path[-1]}/{node_name}"
                device_obj_id = ua.NodeId(node_id_string, 2)
                
                # Create (or reuse) the device object folder
                try:
                    device_obj = self.server.get_node(device_obj_id)
                    await device_obj.read_browse_name()
                    logger.debug(f"Device object {node_id_string} already exists, skipping creation")
                except Exception:
                    device_obj = await current_folder.add_folder(device_obj_id, node_name)
                
                # Set custom DisplayName on device folder if specified in the profile.
                # The agent reads this attribute from the parent folder to build per-sensor
                # display names (device_name field in readings).
                custom_display_name = device_group.get('displayName')
                if custom_display_name:
                    try:
                        await device_obj.write_attribute(
                            ua.AttributeIds.DisplayName,
                            ua.DataValue(ua.LocalizedText(custom_display_name))
                        )
                    except Exception as e:
                        logger.debug(f"Could not set DisplayName for {node_name}: {e}")
                
                # Generate a stable per-device UUID from profile name + full path + device name
                unique_key = f"{profile.name}/{'/'.join(folder_path)}/{node_name}"
                device_uuid = str(uuid_module.uuid5(_DEVICE_UUID_NAMESPACE, unique_key))
                
                # DeviceUUID variable inside the device folder
                uuid_var_id = ua.NodeId(f"{node_id_string}/DeviceUUID", 2)
                try:
                    uuid_var = self.server.get_node(uuid_var_id)
                    await uuid_var.read_browse_name()
                    logger.debug(f"DeviceUUID node for {node_id_string} already exists")
                except Exception:
                    await device_obj.add_variable(uuid_var_id, "DeviceUUID", device_uuid)
                    logger.debug(f"Created DeviceUUID for {node_id_string}: {device_uuid}")
                
                # Value variable inside the device folder, named after the sensor type
                value_var_id = ua.NodeId(f"{node_id_string}/{model_type}", 2)
                try:
                    value_var = self.server.get_node(value_var_id)
                    await value_var.read_browse_name()
                    logger.debug(f"Value node for {node_id_string} already exists, skipping creation")
                except Exception:
                    value_var = await device_obj.add_variable(value_var_id, model_type, 0.0)
                    await value_var.set_writable()
                
                # Set Description on the value variable
                try:
                    if unit:
                        description = f"{device_group.get('description', model_type.replace('_', ' ').title())} in {unit}"
                    else:
                        description = device_group.get('description', model_type.replace('_', ' ').title())
                    await value_var.write_attribute(ua.AttributeIds.Description, ua.DataValue(ua.LocalizedText(description)))
                except Exception as e:
                    logger.debug(f"Could not set description for {node_name}: {e}")
                
                # Device struct points at the value variable; ValueUpdater writes to device.node
                device = Device(
                    node=value_var,
                    device_type=model_type,
                    model_type=model_type,
                    index=i,
                    name=node_name,
                    folder='/'.join(folder_path),
                    unit=unit,
                    min_value=min_value,
                    max_value=max_value,
                    config=device_config,
                    uuid=device_uuid
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
