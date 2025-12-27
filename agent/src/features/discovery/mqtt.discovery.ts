/**
 * MQTT Discovery Plugin
 * 
 * Discovers active MQTT topics by subscribing to wildcard patterns
 * Unique pattern: Push-based (vs pull-based Modbus/OPC-UA)
 * 
 * Discovery Strategy:
 * - Subscribe to wildcard topics (e.g., '#' or 'device/#')
 * - Monitor for configurable duration (default 30s)
 * - Parse topic structure to extract metadata (deviceId, metric)
 * - Infer data types from payloads
 * - Auto-populate endpoints table
 */

import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import { BaseDiscoveryPlugin, DiscoveredDevice, ValidationResult } from './base.discovery';
import * as mqtt from 'mqtt';
import crypto from 'crypto';

export interface MqttDiscoveryOptions {
  brokerUrl?: string;          // e.g., 'mqtt://mosquitto:1883'
  username?: string;
  password?: string;
  wildcardPattern?: string;    // Default: '#' (all topics)
  monitorDurationMs?: number;  // Default: 30000 (30s)
  topicPatterns?: RegExp[];    // Expected topic patterns to parse
  qos?: 0 | 1 | 2;             // QoS for discovery subscription (default: 0)
}

interface TopicData {
  topic: string;
  payloads: string[];          // Store recent payloads for type inference
  messageCount: number;
  firstSeen: Date;
  lastSeen: Date;
  inferredDataType?: string;
  parsedMetadata?: {
    deviceId?: string;
    metric?: string;
    unit?: string;
  };
}

/**
 * Generate MQTT fingerprint
 * Based on topic path (stable identifier)
 * 
 * @param topic - MQTT topic (e.g., "device/sensor01/temperature")
 */
function generateMqttFingerprint(topic: string): string {
  return crypto
    .createHash('sha256')
    .update(`mqtt:${topic}`)
    .digest('hex')
    .substring(0, 32);
}

export class MqttDiscoveryPlugin extends BaseDiscoveryPlugin {
  private client?: mqtt.MqttClient;
  private discoveredTopics: Map<string, TopicData> = new Map();

  // Default topic patterns to parse metadata
  private defaultTopicPatterns: RegExp[] = [
    /^device\/(?<deviceId>[^\/]+)\/(?<metric>[^\/]+)$/,           // device/{id}/{metric}
    /^(?<deviceId>[^\/]+)\/(?<metric>[^\/]+)$/,                   // {id}/{metric}
    /^sensor\/(?<deviceId>[^\/]+)\/(?<metric>[^\/]+)$/,           // sensor/{id}/{metric}
    /^(?<deviceId>[^\/]+)\/sensor\/(?<metric>[^\/]+)$/,           // {id}/sensor/{metric}
    /^iot\/(?<deviceId>[^\/]+)\/(?<metric>[^\/]+)$/,              // iot/{id}/{metric}
    /^home\/(?<deviceId>[^\/]+)\/(?<metric>[^\/]+)$/,             // home/{id}/{metric}
    /^industrial\/(?<deviceId>[^\/]+)\/(?<metric>[^\/]+)$/,       // industrial/{id}/{metric}
  ];

  constructor(logger?: AgentLogger) {
    super('mqtt', logger);
  }

  /**
   * Phase 1: Fast topic discovery
   * Subscribe to wildcard, monitor for N seconds, collect active topics
   */
  async discover(options?: MqttDiscoveryOptions): Promise<DiscoveredDevice[]> {
    this.discoveredTopics.clear();

    const brokerUrl = options?.brokerUrl || process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883';
    const wildcardPattern = options?.wildcardPattern || '#';
    const monitorDurationMs = options?.monitorDurationMs || 30000;
    const qos = options?.qos ?? 0;

    this.logger?.infoSync('Starting MQTT discovery', {
      component: LogComponents.discovery,
      protocol: this.protocol,
      phase: 'discovery',
      brokerUrl,
      wildcardPattern,
      monitorDurationMs
    });

    try {
      // Connect to broker
      this.client = mqtt.connect(brokerUrl, {
        username: options?.username,
        password: options?.password,
        clientId: `iotistic-discovery-${Date.now()}`,
        clean: true,
        reconnectPeriod: 0 // Don't auto-reconnect during discovery
      });

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('MQTT connection timeout'));
        }, 5000);

        this.client!.on('connect', () => {
          clearTimeout(timeout);
          this.logger?.infoSync('Connected to MQTT broker for discovery', {
            component: LogComponents.discovery,
            brokerUrl
          });
          resolve();
        });

        this.client!.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Subscribe to wildcard
      await new Promise<void>((resolve, reject) => {
        this.client!.subscribe(wildcardPattern, { qos }, (err) => {
          if (err) {
            reject(err);
          } else {
            this.logger?.infoSync(`Subscribed to ${wildcardPattern}, monitoring for ${monitorDurationMs}ms`, {
              component: LogComponents.discovery
            });
            resolve();
          }
        });
      });

      // Listen for messages
      this.client.on('message', (topic, payload) => {
        this.handleDiscoveredMessage(topic, payload.toString(), options?.topicPatterns);
      });

      // Monitor for specified duration
      await new Promise(resolve => setTimeout(resolve, monitorDurationMs));

      // Disconnect
      this.client.end(true);

      this.logger?.infoSync(`Discovery complete - found ${this.discoveredTopics.size} active topics`, {
        component: LogComponents.discovery,
        topicCount: this.discoveredTopics.size
      });

      // Convert to DiscoveredDevice format
      return this.convertTopicsToDevices();

    } catch (error) {
      this.logger?.errorSync(
        'MQTT discovery failed',
        error as Error,
        { component: LogComponents.discovery }
      );

      if (this.client) {
        this.client.end(true);
      }

      return [];
    }
  }

  /**
   * Handle incoming message during discovery
   */
  private handleDiscoveredMessage(
    topic: string,
    payload: string,
    customPatterns?: RegExp[]
  ): void {
    // Skip system topics
    if (topic.startsWith('$SYS/')) {
      return;
    }

    const now = new Date();
    const existing = this.discoveredTopics.get(topic);

    if (existing) {
      // Update existing topic data
      existing.payloads.push(payload);
      existing.messageCount++;
      existing.lastSeen = now;

      // Keep only last 10 payloads for type inference
      if (existing.payloads.length > 10) {
        existing.payloads.shift();
      }
    } else {
      // New topic discovered
      const topicData: TopicData = {
        topic,
        payloads: [payload],
        messageCount: 1,
        firstSeen: now,
        lastSeen: now
      };

      // Parse topic metadata
      topicData.parsedMetadata = this.parseTopicMetadata(topic, customPatterns);

      // Infer data type from payload
      topicData.inferredDataType = this.inferDataType(payload);

      this.discoveredTopics.set(topic, topicData);

      this.logger?.debugSync(`New topic discovered: ${topic}`, {
        component: LogComponents.discovery,
        metadata: topicData.parsedMetadata,
        dataType: topicData.inferredDataType
      });
    }
  }

  /**
   * Parse topic to extract metadata (deviceId, metric, unit)
   * Tries custom patterns first, then defaults
   */
  private parseTopicMetadata(
    topic: string,
    customPatterns?: RegExp[]
  ): { deviceId?: string; metric?: string; unit?: string } {
    const patterns = customPatterns || this.defaultTopicPatterns;

    for (const pattern of patterns) {
      const match = topic.match(pattern);
      if (match?.groups) {
        return {
          deviceId: match.groups.deviceId,
          metric: match.groups.metric,
          unit: match.groups.unit
        };
      }
    }

    // Fallback: use last segment as metric, rest as deviceId
    const segments = topic.split('/');
    if (segments.length >= 2) {
      return {
        deviceId: segments.slice(0, -1).join('_'),
        metric: segments[segments.length - 1]
      };
    }

    return { metric: topic.replace(/\//g, '_') };
  }

  /**
   * Infer data type from payload
   * Tries JSON parsing, then numeric types, then fallback to string
   */
  private inferDataType(payload: string): string {
    // Try JSON
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed === 'object' && parsed !== null && 'value' in parsed) {
        // JSON with .value field
        const value = parsed.value;
        if (typeof value === 'number') {
          return Number.isInteger(value) ? 'int32' : 'float32';
        }
        if (typeof value === 'boolean') return 'boolean';
        return 'string';
      }
      // Plain JSON value
      if (typeof parsed === 'number') {
        return Number.isInteger(parsed) ? 'int32' : 'float32';
      }
      if (typeof parsed === 'boolean') return 'boolean';
      return 'string';
    } catch {
      // Not JSON - try numeric
      const trimmed = payload.trim();

      // Boolean
      if (trimmed === 'true' || trimmed === 'false') return 'boolean';
      if (trimmed === '0' || trimmed === '1') return 'boolean';

      // Numeric
      const num = Number(trimmed);
      if (!isNaN(num)) {
        return Number.isInteger(num) ? 'int32' : 'float32';
      }

      // Fallback
      return 'string';
    }
  }

  /**
   * Convert discovered topics to DiscoveredDevice format
   */
  private convertTopicsToDevices(): DiscoveredDevice[] {
    const devices: DiscoveredDevice[] = [];

    for (const [topic, data] of this.discoveredTopics) {
      const fingerprint = generateMqttFingerprint(topic);

      // Determine device name
      const name = data.parsedMetadata?.deviceId
        ? `mqtt_${data.parsedMetadata.deviceId}_${data.parsedMetadata.metric}`
        : `mqtt_${topic.replace(/\//g, '_')}`;

      devices.push({
        name,
        protocol: 'mqtt' as const,
        fingerprint,
        connection: {
          topic,
          qos: 0, // Default QoS
          dataType: data.inferredDataType || 'string',
          ...(data.parsedMetadata?.metric && { metric: data.parsedMetadata.metric }),
          ...(data.parsedMetadata?.deviceId && { deviceId: data.parsedMetadata.deviceId }),
          ...(data.parsedMetadata?.unit && { unit: data.parsedMetadata.unit })
        },
        dataPoints: [], // MQTT uses single topic per endpoint
        confidence: data.messageCount >= 3 ? 'medium' : 'low',
        discoveredAt: data.firstSeen.toISOString(),
        validated: false,
        metadata: {
          messageCount: data.messageCount,
          lastSeen: data.lastSeen.toISOString(),
          samplePayloads: data.payloads.slice(0, 3) // First 3 payloads for reference
        }
      });
    }

    return devices;
  }

  /**
   * Phase 2: Deep validation (read more messages, verify consistency)
   */
  async validate(device: DiscoveredDevice): Promise<ValidationResult> {
    const topic = (device.connection as any).topic;

    this.logger?.infoSync(`Validating MQTT topic: ${topic}`, {
      component: LogComponents.discovery,
      protocol: this.protocol,
      phase: 'validation'
    });

    try {
      // Reconnect for validation
      const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883';
      const client = mqtt.connect(brokerUrl, {
        clientId: `iotistic-validation-${Date.now()}`,
        clean: true,
        reconnectPeriod: 0
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
        client.on('connect', () => {
          clearTimeout(timeout);
          resolve();
        });
        client.on('error', reject);
      });

      // Subscribe and collect 10 messages
      const messages: string[] = [];
      const maxMessages = 10;
      const timeout = 15000; // 15s max

      await new Promise<void>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          client.end(true);
          if (messages.length === 0) {
            reject(new Error('No messages received during validation'));
          } else {
            resolve(); // Partial validation OK
          }
        }, timeout);

        client.subscribe(topic, { qos: 0 }, (err) => {
          if (err) {
            clearTimeout(timeoutHandle);
            reject(err);
          }
        });

        client.on('message', (receivedTopic, payload) => {
          if (receivedTopic === topic) {
            messages.push(payload.toString());

            if (messages.length >= maxMessages) {
              clearTimeout(timeoutHandle);
              client.end(true);
              resolve();
            }
          }
        });
      });

      // Analyze messages for consistency
      const dataTypes = new Set<string>();
      for (const msg of messages) {
        dataTypes.add(this.inferDataType(msg));
      }

      const isConsistent = dataTypes.size === 1;

      this.logger?.infoSync(`Validation complete for ${topic}`, {
        component: LogComponents.discovery,
        messageCount: messages.length,
        isConsistent,
        dataTypes: Array.from(dataTypes)
      });

      return {
        deviceInfo: {
          name: device.name,
          address: topic,
          messageCount: messages.length,
          dataTypeConsistency: isConsistent,
          observedDataTypes: Array.from(dataTypes)
        },
        manufacturer: 'Unknown MQTT Publisher',
        modelNumber: 'MQTT',
        capabilities: ['readable'] // Discovery confirms readable capability
      };

    } catch (error) {
      this.logger?.errorSync(
        `Validation failed for ${topic}`,
        error as Error,
        { component: LogComponents.discovery }
      );

      return {
        deviceInfo: {
          name: device.name,
          address: topic
        },
        manufacturer: 'Unknown',
        modelNumber: 'Unknown',
        capabilities: [] // No confirmed capabilities
      };
    }
  }

  /**
   * Check if MQTT broker is reachable
   */
  async isAvailable(): Promise<boolean> {
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883';

    try {
      const client = mqtt.connect(brokerUrl, {
        clientId: `iotistic-availability-${Date.now()}`,
        clean: true,
        reconnectPeriod: 0
      });

      const available = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          client.end(true);
          resolve(false);
        }, 3000);

        client.on('connect', () => {
          clearTimeout(timeout);
          client.end(true);
          resolve(true);
        });

        client.on('error', () => {
          clearTimeout(timeout);
          client.end(true);
          resolve(false);
        });
      });

      this.logger?.debugSync(`MQTT broker availability: ${available}`, {
        component: LogComponents.discovery,
        brokerUrl
      });

      return available;

    } catch {
      return false;
    }
  }
}
