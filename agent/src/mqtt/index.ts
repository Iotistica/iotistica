/**
 * Centralized MQTT Module
 * 
 * Single MQTT connection shared across all features (jobs, shadows, logging).
 * 
 * Documentation: See agent/docs/mqtt/README.md
 * Quick Start: See agent/docs/mqtt/QUICK-START.md
 * 
 * Exports:
 * - CloudMqttClient: Singleton cloud MQTT connection manager
 * - DictionaryManager: MQTT message key compaction with auto-discovery
 * 
 * Usage:
 * ```typescript
 * import { CloudMqttClient, DictionaryManager } from './mqtt';
 * 
 * const mqttManager = CloudMqttClient.getInstance();
 * await mqttManager.publish(topic, payload, { qos: 1 });
 * 
 * const dictManager = new DictionaryManager(mqttManager, logger, deviceUuid);
 * await dictManager.initialize();
 * await dictManager.compactAndPublish(message, 'modbus');
 * ```
 */

export { CloudMqttClient } from './manager';
export { DictionaryManager} from './dictionary';
export type { DictionaryMetrics } from './dictionary';
export { MessageBufferSync } from './buffer';
export type { BufferSyncConfig } from './buffer';
export type { MessageBufferSyncOptions } from './buffer';
export { IotHubClient as IotHubMqttClient } from '../cloud/azure-iot-client';
export { AwsIotClient as AwsIotMqttClient } from '../cloud/aws-iot-client';
export { GcpIotClient as GcpIotMqttClient } from '../cloud/gcp-iot-client';
export { createExternalPublishTarget } from '../cloud/factory';
export { normalizeTarget } from '../cloud/types';
export type { CloudPublishTarget } from '../cloud/types';
