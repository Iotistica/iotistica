/**
 * Centralized MQTT Module
 * 
 * Single MQTT connection shared across all features (jobs, shadows, logging).
 * 
 * Documentation: See agent/docs/mqtt/README.md
 * Quick Start: See agent/docs/mqtt/QUICK-START.md
 * 
 * Exports:
 * - MqttManager: Singleton MQTT connection manager
 * - DictionaryManager: MQTT message key compaction with auto-discovery
 * 
 * Usage:
 * ```typescript
 * import { MqttManager, DictionaryManager } from './mqtt';
 * 
 * const mqttManager = MqttManager.getInstance();
 * await mqttManager.publish(topic, payload, { qos: 1 });
 * 
 * const dictManager = new DictionaryManager(mqttManager, logger, deviceUuid);
 * await dictManager.initialize();
 * await dictManager.compactAndPublish(message, 'modbus');
 * ```
 */

export { MqttManager } from './manager';
export { DictionaryManager } from './dictionary';
export type { DictionaryMetrics } from './dictionary';
