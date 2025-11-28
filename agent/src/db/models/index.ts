/**
 * Data Models
 * ===========
 * 
 * Database models for endpoints and outputs
 */

// Device model (provisioning and registration)
export { DeviceModel } from './device.model';
export type { Device } from './device.model';

// Endpoint device models (CRUD operations for protocol endpoints)
export { DeviceEndpointModel as DeviceSensorModel } from './endpoint.model';
export type { DeviceEndpoint as DeviceSensor } from './endpoint.model';

// Sensor output configuration (protocol adapter outputs)
export { SensorOutputModel } from './sensor-outputs.model';
export type { DeviceSensorOutput } from './sensor-outputs.model';

// Agent metadata (discovery, etc.)
export { MetadataModel } from './metadata.model';
