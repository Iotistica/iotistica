/**
 * IFC Parser Service
 * 
 * Parses IFC (Industry Foundation Classes) files using web-ifc library
 * and extracts building semantic hierarchy for Digital Twin visualization.
 * 
 * Extracts:
 * - Projects, Sites, Buildings
 * - Floors (IfcBuildingStorey)
 * - Spaces (IfcSpace)
 * - Properties and relationships
 */

import * as WebIFC from 'web-ifc';
import * as fs from 'fs';
import logger from '../../utils/logger';

/**
 * Supported equipment types for extraction
 * 
 * This list can be extended with additional IFC element types as needed:
 * - IFCCHILLER, IFCPUMP, IFCFAN (HVAC equipment)
 * - IFCVALVE, IFCDAMPER, IFCCOIL (control elements)
 * - IFCBOILER, IFCHEATEXCHANGER (thermal equipment)
 * 
 * Note: Some types may require specific web-ifc versions.
 * Currently focusing on stable, widely-supported types.
 * 
 * IMPORTANT: Do NOT include IFCDISTRIBUTIONCONTROLELEMENT or IFCSENSOR here
 * as they are handled separately with special relationship logic.
 */
const EQUIPMENT_TYPES = [
  WebIFC.IFCACTUATOR,                    // Actuators
  WebIFC.IFCALARM,                       // Alarms
  WebIFC.IFCCONTROLLER,                  // Controllers
  // Add more as needed: IFCCHILLER, IFCPUMP, IFCFAN, etc.
];

export interface IFCElement {
  expressId: number;
  type: string;
  name: string;
  globalId?: string;
  properties: Record<string, any>;
}

export interface IFCHierarchy {
  project: IFCElement | null;
  site: IFCElement | null;
  building: IFCElement | null;
  floors: IFCElement[];
  spaces: IFCElement[];
  edgeDevices: IFCElement[];
  sensors: IFCElement[];
  equipment: IFCElement[];  // Generic equipment (HVAC, actuators, alarms, etc.)
  relationships: IFCRelationship[];
}

export interface IFCRelationship {
  from: number; // expressId
  to: number;   // expressId
  type: 'CONTAINS' | 'CONTAINS_FLOOR' | 'CONTAINS_SPACE' | 'HAS_DEVICE' | 'HAS_SENSOR';
}

export class IFCParserService {
  private ifcApi: WebIFC.IfcAPI;

  constructor() {
    this.ifcApi = new WebIFC.IfcAPI();
  }

  /**
   * Initialize the IFC API
   */
  async init(): Promise<void> {
    try {
      await this.ifcApi.Init();
      logger.info('IFC API initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize IFC API:', error);
      throw error;
    }
  }

  /**
   * Parse IFC file and extract semantic hierarchy
   */
  async parseIFCFile(filePath: string): Promise<IFCHierarchy> {
    try {
      // Read IFC file
      const ifcData = fs.readFileSync(filePath);
      const uint8Array = new Uint8Array(ifcData);

      // Open IFC model
      const modelID = this.ifcApi.OpenModel(uint8Array);
      logger.info(`IFC model opened with ID: ${modelID}`);

      // Extract hierarchy
      const hierarchy: IFCHierarchy = {
        project: null,
        site: null,
        building: null,
        floors: [],
        spaces: [],
        edgeDevices: [],
        sensors: [],
        equipment: [],
        relationships: [],
      };

      // Extract project
      const projects = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCPROJECT);
      if (projects.size() > 0) {
        const projectId = projects.get(0);
        hierarchy.project = this.getElementDetails(modelID, projectId, 'IfcProject');
      }

      // Extract site
      const sites = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCSITE);
      if (sites.size() > 0) {
        const siteId = sites.get(0);
        hierarchy.site = this.getElementDetails(modelID, siteId, 'IfcSite');
        if (hierarchy.project) {
          hierarchy.relationships.push({
            from: hierarchy.project.expressId,
            to: siteId,
            type: 'CONTAINS',
          });
        }
      }

      // Extract building
      const buildings = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCBUILDING);
      if (buildings.size() > 0) {
        const buildingId = buildings.get(0);
        hierarchy.building = this.getElementDetails(modelID, buildingId, 'IfcBuilding');
        if (hierarchy.site) {
          hierarchy.relationships.push({
            from: hierarchy.site.expressId,
            to: buildingId,
            type: 'CONTAINS',
          });
        }
      }

      // Extract floors (building storeys)
      const floors = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY);
      for (let i = 0; i < floors.size(); i++) {
        const floorId = floors.get(i);
        const floor = this.getElementDetails(modelID, floorId, 'IfcBuildingStorey');
        hierarchy.floors.push(floor);

        // Relationship: Building -> Floor
        if (hierarchy.building) {
          hierarchy.relationships.push({
            from: hierarchy.building.expressId,
            to: floorId,
            type: 'CONTAINS_FLOOR',
          });
        }
      }

      // Extract spaces
      const spaces = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCSPACE);
      for (let i = 0; i < spaces.size(); i++) {
        const spaceId = spaces.get(i);
        const space = this.getElementDetails(modelID, spaceId, 'IfcSpace');
        hierarchy.spaces.push(space);

        // Find parent floor by spatial containment
        const parentFloor = this.findParentFloor(modelID, spaceId, hierarchy.floors);
        if (parentFloor) {
          hierarchy.relationships.push({
            from: parentFloor.expressId,
            to: spaceId,
            type: 'CONTAINS_SPACE',
          });
        }
      }

      // Extract edge agents (IFCDISTRIBUTIONCONTROLELEMENT)
      const edgeDevices = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCDISTRIBUTIONCONTROLELEMENT);
      logger.info(`Found ${edgeDevices.size()} edge agents`);
      for (let i = 0; i < edgeDevices.size(); i++) {
        const deviceId = edgeDevices.get(i);
        const device = this.getElementDetails(modelID, deviceId, 'IfcDistributionControlElement');
        hierarchy.edgeDevices.push(device);

        // Find parent space by spatial containment
        const parentSpace = this.findParentSpace(modelID, deviceId, hierarchy.spaces);
        if (parentSpace) {
          logger.info(`Device ${device.name} (${deviceId}) -> Space ${parentSpace.name}`);
          hierarchy.relationships.push({
            from: parentSpace.expressId,
            to: deviceId,
            type: 'HAS_DEVICE',
          });
        } else {
          logger.warn(`No parent space found for device ${device.name} (${deviceId})`);
        }
      }

      // Extract sensors (IFCSENSOR)
      const sensors = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCSENSOR);
      logger.info(`Found ${sensors.size()} sensors`);
      for (let i = 0; i < sensors.size(); i++) {
        const sensorId = sensors.get(i);
        const sensor = this.getElementDetails(modelID, sensorId, 'IfcSensor');
        hierarchy.sensors.push(sensor);

        // Find parent edge device by assignment relationship
        const parentDevice = this.findParentDevice(modelID, sensorId, hierarchy.edgeDevices);
        if (parentDevice) {
          logger.info(`Sensor ${sensor.name} (${sensorId}) -> Device ${parentDevice.name}`);
          hierarchy.relationships.push({
            from: parentDevice.expressId,
            to: sensorId,
            type: 'HAS_SENSOR',
          });
        } else {
          logger.warn(`No parent device found for sensor ${sensor.name} (${sensorId})`);
        }
      }

      // Extract additional equipment types (HVAC, actuators, alarms, etc.)
      this.extractEquipment(modelID, hierarchy);

      // Close model
      this.ifcApi.CloseModel(modelID);

      logger.info(`Parsed IFC: ${hierarchy.floors.length} floors, ${hierarchy.spaces.length} spaces, ${hierarchy.edgeDevices.length} agents, ${hierarchy.sensors.length} sensors, ${hierarchy.equipment.length} equipment`);
      return hierarchy;
    } catch (error) {
      logger.error('Failed to parse IFC file:', error);
      throw error;
    }
  }

  /**
   * Get detailed information about an IFC element
   */
  private getElementDetails(modelID: number, expressId: number, type: string): IFCElement {
    try {
      const properties = this.ifcApi.GetLine(modelID, expressId);
      
      // Extract name
      let name = `${type} ${expressId}`;
      if (properties.Name && properties.Name.value) {
        name = properties.Name.value;
      }

      // Extract GlobalId
      let globalId: string | undefined;
      if (properties.GlobalId && properties.GlobalId.value) {
        globalId = properties.GlobalId.value;
      }

      return {
        expressId,
        type,
        name,
        globalId,
        properties: {
          description: properties.Description?.value || '',
          objectType: properties.ObjectType?.value || '',
        },
      };
    } catch (error) {
      logger.warn(`Failed to get element ${expressId} details:`, error);
      return {
        expressId,
        type,
        name: `${type} ${expressId}`,
        properties: {},
      };
    }
  }

  /**
   * Find parent floor for a space using spatial containment
   */
  private findParentFloor(
    modelID: number,
    spaceId: number,
    floors: IFCElement[]
  ): IFCElement | null {
    try {
      // First try: IFCRELCONTAINEDINSPATIALSTRUCTURE (most common)
      const relContained = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
      
      for (let i = 0; i < relContained.size(); i++) {
        const relId = relContained.get(i);
        const rel = this.ifcApi.GetLine(modelID, relId);
        
        // Check if this relationship contains our space
        if (rel.RelatedElements) {
          const elements = rel.RelatedElements;
          for (let j = 0; j < elements.length; j++) {
            if (elements[j].value === spaceId) {
              // Found relationship containing this space
              // Check if parent is a floor
              const parentId = rel.RelatingStructure?.value;
              if (parentId) {
                const parentFloor = floors.find(f => f.expressId === parentId);
                if (parentFloor) {
                  return parentFloor;
                }
              }
            }
          }
        }
      }

      // Second try: IFCRELAGGREGATES (alternative spatial structure)
      const relAggregates = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELAGGREGATES);
      
      for (let i = 0; i < relAggregates.size(); i++) {
        const relId = relAggregates.get(i);
        const rel = this.ifcApi.GetLine(modelID, relId);
        
        // Check if this relationship contains our space
        if (rel.RelatedObjects) {
          const objects = rel.RelatedObjects;
          for (let j = 0; j < objects.length; j++) {
            if (objects[j].value === spaceId) {
              // Found relationship containing this space
              // Check if parent is a floor
              const parentId = rel.RelatingObject?.value;
              if (parentId) {
                const parentFloor = floors.find(f => f.expressId === parentId);
                if (parentFloor) {
                  return parentFloor;
                }
              }
            }
          }
        }
      }
    } catch (error) {
      logger.warn(`Failed to find parent floor for space ${spaceId}:`, error);
    }
    
    return null;
  }

  /**
   * Find parent space for an edge device using spatial containment
   */
  private findParentSpace(
    modelID: number,
    deviceId: number,
    spaces: IFCElement[]
  ): IFCElement | null {
    try {
      // Get spatial structure relationships
      const relContained = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
      
      for (let i = 0; i < relContained.size(); i++) {
        const relId = relContained.get(i);
        const rel = this.ifcApi.GetLine(modelID, relId);
        
        // Check if this relationship contains our device
        if (rel.RelatedElements) {
          const elements = rel.RelatedElements;
          for (let j = 0; j < elements.length; j++) {
            if (elements[j].value === deviceId) {
              // Found relationship containing this device
              // Check if parent is a space
              const parentId = rel.RelatingStructure?.value;
              if (parentId) {
                const parentSpace = spaces.find(s => s.expressId === parentId);
                if (parentSpace) {
                  return parentSpace;
                }
              }
            }
          }
        }
      }
    } catch (error) {
      logger.warn(`Failed to find parent space for device ${deviceId}:`, error);
    }
    return null;
  }

  /**
   * Find parent edge device for a sensor using assignment relationships
   */
  private findParentDevice(
    modelID: number,
    sensorId: number,
    edgeDevices: IFCElement[]
  ): IFCElement | null {
    try {
      // Get assignment relationships (IFCRELASSIGNSTOACTOR)
      const relAssigns = this.ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELASSIGNSTOACTOR);
      logger.info(`\n=== SENSOR ${sensorId} RELATIONSHIP SEARCH ===`);
      logger.info(`Found ${relAssigns.size()} IFCRELASSIGNSTOACTOR relationships`);
      logger.info(`Available edge agents: ${edgeDevices.map(d => `${d.name} (${d.expressId})`).join(', ')}`);
      
      for (let i = 0; i < relAssigns.size(); i++) {
        const relId = relAssigns.get(i);
        const rel = this.ifcApi.GetLine(modelID, relId);
        
        logger.info(`\nChecking relationship #${relId}:`);
        logger.info(`  Raw relationship:`, JSON.stringify(rel, null, 2));
        logger.info(`  Summary:`, {
          hasRelatedObjects: !!rel.RelatedObjects,
          relatedObjectsType: rel.RelatedObjects?.constructor?.name,
          relatedObjectsLength: rel.RelatedObjects?.length,
          hasRelatingActor: !!rel.RelatingActor,
          relatingActorType: typeof rel.RelatingActor,
          relatingActorValue: rel.RelatingActor?.value,
        });
        
        // Check if this relationship contains our sensor
        if (rel.RelatedObjects) {
          const objects = rel.RelatedObjects;
          for (let j = 0; j < objects.length; j++) {
            const objValue = objects[j].value;
            logger.info(`      Related object [${j}]: ${objValue}`);
            
            if (objValue === sensorId) {
              // Found relationship containing this sensor
              logger.info(`      ✓ Match! Sensor ${sensorId} found in relationship`);
              
              // Check if assigned to an edge device
              // RelatingActor can be in various formats - try all known patterns
              let actorId: number | null = null;
              
              logger.info(`      Attempting to extract RelatingActor...`);
              logger.info(`      RelatingActor full object:`, rel.RelatingActor);
              
              if (rel.RelatingActor) {
                // Pattern 1: Object with .value property
                if (rel.RelatingActor.value !== null && rel.RelatingActor.value !== undefined) {
                  actorId = rel.RelatingActor.value;
                }
                // Pattern 2: Direct number
                else if (typeof rel.RelatingActor === 'number') {
                  actorId = rel.RelatingActor;
                }
                // Pattern 3: Object with .expressID property
                else if (rel.RelatingActor.expressID !== undefined && rel.RelatingActor.expressID !== null) {
                  actorId = rel.RelatingActor.expressID;
                }
                // Pattern 4: Object with ._id property (some web-ifc versions)
                else if (rel.RelatingActor._id !== undefined && rel.RelatingActor._id !== null) {
                  actorId = rel.RelatingActor._id;
                }
                // Pattern 5: Try to get the line if it's a handle
                else if (typeof rel.RelatingActor === 'object') {
                  try {
                    const actorLine = this.ifcApi.GetLine(modelID, rel.RelatingActor as any);
                    if (actorLine && actorLine.expressID) {
                      actorId = actorLine.expressID;
                    }
                  } catch (e) {
                    // Not a valid handle
                  }
                }
              }
              
              logger.info(`      Relating actor ID: ${actorId} (from RelatingActor:`, rel.RelatingActor, ')');
              
              if (actorId) {
                const parentDevice = edgeDevices.find(d => d.expressId === actorId);
                if (parentDevice) {
                  logger.info(`      ✓ Found parent device: ${parentDevice.name}`);
                  return parentDevice;
                } else {
                  logger.warn(`      ✗ Actor ${actorId} not found in edge agents list:`, edgeDevices.map(d => d.expressId));
                }
              }
            }
          }
        }
      }
    } catch (error) {
      logger.warn(`Failed to find parent device for sensor ${sensorId}:`, error);
    }
    return null;
  }

  /**
   * Extract generic equipment types (HVAC, actuators, alarms, controllers)
   * 
   * This method provides a flexible way to extract any IFC equipment type
   * without modifying the core parsing logic. Simply add new types to the
   * EQUIPMENT_TYPES array at the top of this file.
   */
  private extractEquipment(modelID: number, hierarchy: IFCHierarchy): void {
    try {
      logger.info(`Extracting ${EQUIPMENT_TYPES.length} equipment types...`);
      
      for (const equipmentType of EQUIPMENT_TYPES) {
        try {
          const ids = this.ifcApi.GetLineIDsWithType(modelID, equipmentType);
          
          if (ids.size() === 0) continue;
          
          // Get the type name for logging
          const typeName = this.getIFCTypeName(equipmentType);
          logger.info(`  Found ${ids.size()} ${typeName} elements`);
          
          for (let i = 0; i < ids.size(); i++) {
            const id = ids.get(i);
            const element = this.getElementDetails(modelID, id, typeName);
            hierarchy.equipment.push(element);
            
            // Try to place equipment inside a space
            const parentSpace = this.findParentSpace(modelID, id, hierarchy.spaces);
            if (parentSpace) {
              logger.info(`  Equipment ${element.name} (${id}) → Space ${parentSpace.name}`);
              hierarchy.relationships.push({
                from: parentSpace.expressId,
                to: id,
                type: 'CONTAINS',
              });
            } else {
              logger.info(`  Equipment ${element.name} (${id}) - no parent space`);
            }
          }
        } catch (typeError) {
          // Some equipment types may not be available in this web-ifc version
          logger.warn(`  Skipping unsupported equipment type ${equipmentType}:`, typeError);
        }
      }
    } catch (error) {
      logger.warn('Failed to extract equipment:', error);
    }
  }

  /**
   * Get human-readable IFC type name
   */
  private getIFCTypeName(typeId: number): string {
    // Map common IFC type IDs to readable names
    const typeNames: { [key: number]: string } = {
      [WebIFC.IFCDISTRIBUTIONCONTROLELEMENT]: 'IfcDistributionControlElement',
      [WebIFC.IFCSENSOR]: 'IfcSensor',
      [WebIFC.IFCACTUATOR]: 'IfcActuator',
      [WebIFC.IFCALARM]: 'IfcAlarm',
      [WebIFC.IFCCONTROLLER]: 'IfcController',
    };
    
    return typeNames[typeId] || `IfcType_${typeId}`;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    // web-ifc handles cleanup internally
    logger.info('IFC parser disposed');
  }
}
