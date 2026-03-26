/**
 * Data Models
 * ===========
 * 
 * Database models for endpoints and outputs
 */

// Device model (provisioning and registration)
export { AgentModel as DeviceModel } from './agent.model';
export type { Agent as Device } from './agent.model';

// Endpoint device models (CRUD operations for protocol endpoints)
export { EndpointModel as DeviceSensorModel } from './endpoint.model';
export type { Endpoint as DeviceSensor } from './endpoint.model';

// Sensor output configuration (protocol adapter outputs)
export { EndpointOutputModel as SensorOutputModel } from './endpoint-outputs.model';
export type { DeviceEndpointOutput as DeviceSensorOutput } from './endpoint-outputs.model';

// Agent metadata (discovery, etc.)
export { MetadataModel } from './metadata.model';

// Message buffer (offline queue for MQTT)
export { MessageBufferModel } from './message-buffer.model';
export type { MessageBufferRecord, BufferStats } from './message-buffer.model';

// MQTT auth tables (agent-local broker auth reconciliation)
export { MqttAuthModel } from './mqtt-auth.model';

// Dictionary persistence (MQTT key compression)
export { DictionaryModel } from './dictionary.model';
export type { DictionaryEntry, DictionaryDelta, DictionaryMetadata } from './dictionary.model';

// Protocol devices (physical/logical devices behind protocol endpoints)
export { DeviceModel as ProtocolDevicesModel } from './device.model';
export type { Device as ProtocolDevice } from './device.model';
