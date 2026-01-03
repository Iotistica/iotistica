/**
 * MQTT Discovery Plugin
 * 
 * Discovers active MQTT topics by subscribing to wildcard patterns
 * Unique pattern: Push-based (vs pull-based Modbus/OPC-UA)
 * 
 * 🔀 HYBRID DISCOVERY ARCHITECTURE:
 * 
 * This plugin implements ACTIVE discovery (user-triggered snapshots),
 * complemented by PASSIVE observation in the runtime MQTT adapter.
 * 
 * 1️⃣ Passive Observation (Always-On, Bounded)
 *    - Runtime adapter tracks topics during normal operation
 *    - Bounded memory (2000 topics max, LRU eviction)
 *    - Tracks: firstSeen, lastSeen, liveCount, retainedCount
 *    - Does NOT auto-create devices (only awareness)
 *    - See: agent/src/features/endpoints/mqtt/adapter.ts
 * 
 * 2️⃣ Active Discovery (This Plugin - User Triggered)
 *    - Explicit discoveryRoots (e.g., ['edge/+', 'sensor/+/data'])
 *    - Time-bounded sampling (default 30s)
 *    - Strong validation (pattern matching, safety checks)
 *    - Emits candidate endpoints
 *    - 30s window is about SAMPLING, not COMPLETENESS
 * 
 * 3️⃣ Deferred Validation (Per-Topic, Flexible)
 *    - Accepts slow publishers (1+ messages OK)
 *    - Computes publish rate, separates retained vs live
 *    - Establishes truth (not discovery)
 * 
 * Why This Pattern?
 * ❌ Pure 30s windows: Miss low-frequency/battery-powered sensors
 * ❌ Pure continuous: Memory growth, topic explosion, no user intent
 * ✅ Hybrid: Continuous awareness + discrete snapshots + user control
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
import { getMqttAdapterRegistry, type ObservedTopic } from '../endpoints/mqtt/adapter.js';

export interface MqttDiscoveryOptions {
  brokerUrl?: string;          // e.g., 'mqtt://mosquitto:1883'
  username?: string;
  password?: string;
  discoveryRoots?: string[];   // REQUIRED: Explicit topic roots (e.g., ['edge/+', 'devices/+/telemetry'])
                               // 🚨 NEVER use '#' - causes OOM, event loop blocking, system instability
                               // ✅ Use targeted patterns: 'device/+', 'sensor/+/data', 'iot/+/telemetry'
  monitorDurationMs?: number;  // Default: 30000 (30s)
  topicPatterns?: RegExp[];    // Expected topic patterns to parse
  qos?: 0 | 1 | 2;             // QoS for discovery subscription (default: 0)
  observedTopics?: Array<{     // HYBRID: Topics observed by runtime adapter (outside 30s window)
    topic: string;
    firstSeen: Date;
    lastSeen: Date;
    messageCount: number;
    hasLiveMessages: boolean;
    retainedCount: number;
    liveCount: number;
    samplePayload?: string;
  }>;
}

interface TopicData {
  topic: string;
  payloads: string[];          // Store recent payloads for type inference
  messageCount: number;        // Total messages (retained + live)
  liveMessageCount: number;    // Non-retained messages only
  retainedMessageCount: number; // Retained messages only
  hasLiveMessages: boolean;    // True if at least one non-retained message received
  firstSeen: Date;
  lastSeen: Date;
  inferredDataType?: string;
  isCompoundTopic?: boolean;   // True if publishes JSON with multiple metrics
  compoundFields?: string[];   // Field names found in JSON payloads
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

/**
 * Validate discovery roots for dangerous patterns
 * Prevents OOM and system instability from overly broad subscriptions
 * 
 * @param roots - Discovery root patterns
 * @returns Validation result with errors/warnings
 */
function validateDiscoveryRoots(roots: string[]): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!roots || roots.length === 0) {
    errors.push('discoveryRoots is required - specify explicit topic patterns (e.g., ["edge/+", "devices/+/telemetry"])');
    return { valid: false, errors, warnings };
  }

  for (const root of roots) {
    // 🚨 CRITICAL: Block '#' wildcard (all topics)
    if (root === '#') {
      errors.push('❌ DANGEROUS: "#" subscribes to ALL topics - causes OOM, event loop blocking, system crash');
      errors.push('   Use targeted patterns instead: "edge/+", "devices/+/telemetry", "sensors/+/data"');
    }

    // 🚨 CRITICAL: Block '+/#' patterns (too broad)
    if (root.match(/^\+\//) || root === '+') {
      errors.push(`❌ DANGEROUS: "${root}" is too broad - subscribe to specific root prefixes`);
      errors.push('   Example: Instead of "+/#", use "edge/+" or "devices/+"');
    }

    // ⚠️ WARNING: Multiple levels of wildcards
    const wildcardCount = (root.match(/[#+]/g) || []).length;
    if (wildcardCount > 2) {
      warnings.push(`⚠️  "${root}" has ${wildcardCount} wildcards - may cause high message volume`);
    }

    // ⚠️ WARNING: Ending with '/#' without prefix
    if (root.endsWith('/#') && root.split('/').length <= 2) {
      warnings.push(`⚠️  "${root}" ends with /#  - consider more specific pattern (e.g., "edge/devices/+" instead of "edge/#")`);
    }

    // ⚠️ WARNING: $SYS topics
    if (root.startsWith('$SYS')) {
      warnings.push(`⚠️  "${root}" subscribes to broker internals - usually not needed for discovery`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
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
    const discoveryRoots = options?.discoveryRoots || [];
    const monitorDurationMs = options?.monitorDurationMs || 30000;
    const qos = options?.qos ?? 0;
    
    // HYBRID AUTO-DISCOVERY: If no observer data provided, try to get it from registry
    // This matches Modbus/OPC-UA pattern - discovery is self-sufficient
    let observedTopics = options?.observedTopics;
    
    if (!observedTopics) {
      try {
        const registry = getMqttAdapterRegistry();
        const allAdapters = registry.getAllAdapters();
        
        this.logger?.infoSync(`Found ${allAdapters.length} MQTT adapter(s) in registry`, {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          adapterCount: allAdapters.length
        });
        
        const adapter = registry.getAdapter();
        if (adapter) {
          observedTopics = adapter.getRecentlyObservedTopics(60, 1);
          this.logger?.infoSync(`Retrieved ${observedTopics.length} observed topics from running MQTT adapter`, {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            observedCount: observedTopics.length,
            topics: observedTopics.map(t => t.topic)
          });
        } else {
          this.logger?.warnSync('No running MQTT adapter found in registry', {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            protocol: this.protocol,
            possibleCauses: [
              'MQTT protocol not enabled in target state',
              'MQTT adapter failed to start',
              'Discovery running before adapter initialized',
              'No MQTT endpoints configured'
            ],
            hint: 'Check for "MQTT Adapter started successfully" log or enable MQTT in protocols config'
          });
        }
      } catch (error) {
        this.logger?.errorSync('Failed to retrieve observer data from adapter', error as Error, {
          component: LogComponents.discovery + "] [" + this.protocol as any
        });
      }
    }
    
    // HYBRID: Pre-populate with observer-tracked topics (from runtime adapter)
    // This solves "no data during 30s window" problem for low-frequency publishers
    if (observedTopics && observedTopics.length > 0) {
      this.logger?.infoSync(`Pre-populating with ${observedTopics.length} observer-tracked topics`, {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        protocol: this.protocol,
        observedCount: observedTopics.length,
        topics: observedTopics.map(t => t.topic)
      });
      
      for (const observed of observedTopics) {
        // Convert observer format to discovery TopicData format
        const topicData = {
          topic: observed.topic,
          payloads: observed.samplePayload ? [observed.samplePayload] : [],
          messageCount: observed.messageCount,
          liveMessageCount: observed.liveCount,
          retainedMessageCount: observed.retainedCount,
          hasLiveMessages: observed.hasLiveMessages,
          firstSeen: observed.firstSeen,
          lastSeen: observed.lastSeen,
          parsedMetadata: this.parseTopicMetadata(observed.topic, options?.topicPatterns),
          inferredDataType: observed.samplePayload ? this.inferDataType(observed.samplePayload) : 'string'
        };
        
        this.discoveredTopics.set(observed.topic, topicData);
        
        this.logger?.infoSync(`Imported observer topic: ${observed.topic}`, {
          component: LogComponents.discovery + "] [" + this.protocol as any,
          liveCount: observed.liveCount,
          retainedCount: observed.retainedCount,
          lastSeen: observed.lastSeen,
          dataType: topicData.inferredDataType
        });
      }
      
      this.logger?.infoSync(`Observer topics imported - now running 30s window to update/validate`, {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        prePopulated: this.discoveredTopics.size
      });
    } else {
      this.logger?.warnSync(`No observer topics provided - relying on 30s window only`, {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        hint: 'Low-frequency publishers may be missed'
      });
    }

    // 🚨 CRITICAL: Validate discovery roots for dangerous patterns
    const validation = validateDiscoveryRoots(discoveryRoots);
    
    if (!validation.valid) {
      const errorMsg = `Invalid MQTT discovery configuration:\n${validation.errors.join('\n')}`;
      this.logger?.errorSync(errorMsg, undefined, {
        component: LogComponents.discovery + "] [" + this.protocol as any
      });
      throw new Error(errorMsg);
    }

    // Log warnings (non-fatal)
    if (validation.warnings.length > 0) {
      for (const warning of validation.warnings) {
        this.logger?.warnSync(warning, {
          component: LogComponents.discovery + "] [" + this.protocol as any
        });
      }
    }

    this.logger?.infoSync('Starting MQTT discovery', {
      component: LogComponents.discovery + "] [" + this.protocol as any,
      protocol: this.protocol,
      phase: 'discovery',
      brokerUrl,
      discoveryRoots,
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
          this.logger?.errorSync('MQTT connection timeout - broker unreachable', undefined, {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            brokerUrl,
            timeout: '5000ms',
            hint: 'Check if broker is running and accessible from agent container'
          });
          reject(new Error(`MQTT connection timeout - cannot reach ${brokerUrl}`));
        }, 5000);

        this.client!.on('connect', () => {
          clearTimeout(timeout);
          this.logger?.infoSync('Connected to MQTT broker for discovery', {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            brokerUrl
          });
          resolve();
        });

        this.client!.on('error', (err) => {
          clearTimeout(timeout);
          this.logger?.errorSync('MQTT connection error', err, {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            brokerUrl,
            error: err.message
          });
          reject(err);
        });
      });

      // Subscribe to each discovery root individually
      // This prevents broker overload from overly broad patterns
      for (const root of discoveryRoots) {
        await new Promise<void>((resolve, reject) => {
          this.client!.subscribe(root, { qos }, (err) => {
            if (err) {
              this.logger?.errorSync(`Failed to subscribe to ${root}`, err, {
                component: LogComponents.discovery + "] [" + this.protocol as any
              });
              reject(err);
            } else {
              this.logger?.infoSync(`Subscribed to discovery root: ${root}`, {
                component: LogComponents.discovery + "] [" + this.protocol as any
              });
              resolve();
            }
          });
        });
      }

      this.logger?.infoSync(`Monitoring ${discoveryRoots.length} discovery roots for ${monitorDurationMs}ms`, {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        rootCount: discoveryRoots.length
      });

      // Listen for messages with packet info to detect retained flag
      this.client.on('message', (topic, payload, packet) => {
        this.handleDiscoveredMessage(topic, payload.toString(), packet.retain, options?.topicPatterns);
      });

      // Monitor for specified duration
      await new Promise(resolve => setTimeout(resolve, monitorDurationMs));

      // Disconnect
      this.client.end(true);

      // Analyze discovery results for warnings
      const retainedOnlyTopics = Array.from(this.discoveredTopics.values()).filter(t => !t.hasLiveMessages);
      const totalTopics = this.discoveredTopics.size;
      const retainedOnlyCount = retainedOnlyTopics.length;

      this.logger?.infoSync(`Discovery complete - found ${totalTopics} active topics`, {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        topicCount: totalTopics,
        liveTopics: totalTopics - retainedOnlyCount,
        retainedOnlyTopics: retainedOnlyCount
      });

      // ⚠️ Warn about retained-only topics (may indicate offline publishers)
      if (retainedOnlyCount > 0) {
        this.logger?.warnSync(
          `Found ${retainedOnlyCount} topic(s) with only retained messages - publishers may be offline`,
          {
            component: LogComponents.discovery + "] [" + this.protocol as any,
            retainedOnlyTopics: retainedOnlyTopics.map(t => t.topic).slice(0, 10), // First 10
            recommendation: 'Verify publishers are active before enabling these endpoints'
          }
        );
      }

      // Convert to DiscoveredDevice format
      return this.convertTopicsToDevices();

    } catch (error) {
      this.logger?.errorSync(
        'MQTT discovery failed',
        error as Error,
        { component: LogComponents.discovery + "] [" + this.protocol as any }
      );

      if (this.client) {
        this.client.end(true);
      }

      return [];
    }
  }

  /**
   * Handle incoming message during discovery
   * Tracks both retained and live messages separately for accurate confidence scoring
   */
  private handleDiscoveredMessage(
    topic: string,
    payload: string,
    isRetained: boolean,
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

      // Track retained vs live messages
      if (isRetained) {
        existing.retainedMessageCount++;
      } else {
        existing.liveMessageCount++;
        existing.hasLiveMessages = true;
      }
      
      // Update compound fields if json-compound type
      if (existing.inferredDataType === 'json-compound') {
        const newFields = this.extractCompoundFields(payload);
        if (newFields.length > 0 && existing.compoundFields) {
          // Merge unique fields (devices may add/remove fields)
          const allFields = new Set([...existing.compoundFields, ...newFields]);
          existing.compoundFields = Array.from(allFields);
        }
      }

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
        liveMessageCount: isRetained ? 0 : 1,
        retainedMessageCount: isRetained ? 1 : 0,
        hasLiveMessages: !isRetained,
        firstSeen: now,
        lastSeen: now
      };

      // Parse topic metadata
      topicData.parsedMetadata = this.parseTopicMetadata(topic, customPatterns);

      // Infer data type from payload
      topicData.inferredDataType = this.inferDataType(payload);
      
      // If compound topic, extract field names
      if (topicData.inferredDataType === 'json-compound') {
        topicData.isCompoundTopic = true;
        topicData.compoundFields = this.extractCompoundFields(payload);
      }

      this.discoveredTopics.set(topic, topicData);

      this.logger?.debugSync(`New topic discovered: ${topic} (retained: ${isRetained})`, {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        metadata: topicData.parsedMetadata,
        dataType: topicData.inferredDataType,
        isCompound: topicData.isCompoundTopic,
        fields: topicData.compoundFields,
        isRetained
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
   * Infer data FORMAT (not specific type) from payload
   * 
   * CRITICAL: Uses broad categories (number, boolean, string, json) instead of 
   * specific types (int32, float32) because industrial MQTT devices:
   * - Change formats on firmware updates (string → number → JSON)
   * - Use numeric status codes that aren't booleans ("0"/"1" may be states, not true/false)
   * - Switch precision (50 → 50.0 on calibration)
   * 
   * Returns: 'number' | 'boolean' | 'string' | 'json' | 'json-compound'
   * Manual confirmation required before locking to specific numeric type (int32/float32)
   * 
   * Note: 'json-compound' indicates multiple metrics in one topic (e.g., {temp:42, pressure:9.1})
   *       These should NOT be split during discovery - adapter handles at runtime
   */
  private inferDataType(payload: string): string {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(payload);
      
      // Complex object or array → check if compound topic
      if (typeof parsed === 'object' && parsed !== null) {
        // Array or object with multiple data fields → compound topic
        if (Array.isArray(parsed)) {
          return 'json';  // Array structure (not compound metrics)
        }
        
        // Object with multiple metric-like fields → compound topic
        // Look for numeric/boolean values that look like sensor readings
        const fields = Object.keys(parsed);
        const dataFields = fields.filter(key => {
          const value = parsed[key];
          return typeof value === 'number' || typeof value === 'boolean';
        });
        
        // If 2+ numeric/boolean fields, likely compound metrics
        // Example: {temperature: 42, pressure: 9.1, humidity: 65}
        if (dataFields.length >= 2) {
          return 'json-compound';
        }
        
        // Single data field or metadata-heavy → regular json
        return 'json';
      }
      
      // JSON primitive values - infer broad category
      if (typeof parsed === 'number') {
        return 'number';  // Don't distinguish int32 vs float32
      }
      
      if (typeof parsed === 'boolean') {
        return 'boolean';  // Explicit true/false in JSON
      }
      
      // JSON string value
      return 'string';
      
    } catch {
      // Not JSON - analyze raw string
      const trimmed = payload.trim();

      // Explicit boolean keywords (case-insensitive)
      const lower = trimmed.toLowerCase();
      if (lower === 'true' || lower === 'false') {
        return 'boolean';
      }

      // ⚠️ CRITICAL: DO NOT treat "0"/"1" as boolean!
      // Industrial devices use these as:
      // - Status codes (0=OK, 1=ERROR, 2=WARNING)
      // - Numeric values (pump speed step 0-10)
      // - Binary flags in larger context
      // Let user confirm if they're truly boolean

      // Numeric detection (but return broad 'number' category)
      const num = Number(trimmed);
      if (!isNaN(num) && trimmed !== '') {
        return 'number';  // Could be int, float, or change between them
      }

      // Default fallback
      return 'string';
    }
  }

  /**
   * Analyze JSON payload to extract compound field names
   * Only called for json-compound topics
   * 
   * IMPORTANT: Discovery does NOT split compound topics into separate endpoints.
   * This just identifies the fields for user awareness.
   * 
   * Runtime adapter configuration handles:
   * - Parsing JSON structure
   * - Extracting individual metrics
   * - Applying transformations
   * - Mapping to data points
   * 
   * Example:
   *   Topic: edge/device-1/telemetry
   *   Payload: {"temperature": 42, "pressure": 9.1, "humidity": 65}
   *   Discovery: Creates 1 endpoint, marks isCompoundTopic=true, fields=["temperature","pressure","humidity"]
   *   Adapter: User configures JSON path extraction ($.temperature, $.pressure, etc.)
   */
  private extractCompoundFields(payload: string): string[] {
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return Object.keys(parsed).filter(key => {
          const value = parsed[key];
          // Only include numeric/boolean fields (likely metrics)
          return typeof value === 'number' || typeof value === 'boolean';
        });
      }
    } catch {
      // Ignore parse errors
    }
    return [];
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

      // Calculate confidence based on live (non-retained) messages
      // Retained messages inflate confidence - they prove nothing about active publishers
      let confidence: 'high' | 'medium' | 'low';
      let confidenceReason: string | undefined;
      
      if (!data.hasLiveMessages) {
        // Only retained messages - lowest confidence (publisher may be offline)
        confidence = 'low';
        confidenceReason = 'Only retained messages (no active publisher observed)';
      } else if (data.liveMessageCount >= 3) {
        // Multiple live messages - publisher is actively sending
        confidence = 'medium';
        confidenceReason = `${data.liveMessageCount} live messages received`;
      } else {
        // Few live messages - uncertain
        confidence = 'low';
        confidenceReason = `Only ${data.liveMessageCount} live message(s) - needs more observation`;
      }
      
      // ⚠️ Lower confidence if mostly retained messages
      if (data.hasLiveMessages && data.retainedMessageCount > data.liveMessageCount * 3) {
        // If >75% retained, lower confidence one level
        if (confidence === 'medium') {
          confidence = 'low';
          confidenceReason = `Mostly retained messages (${data.retainedMessageCount} retained vs ${data.liveMessageCount} live) - publisher may be sporadic`;
        }
      }

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
        confidence,
        discoveredAt: data.firstSeen.toISOString(),
        validated: false,
        metadata: {
          messageCount: data.messageCount,
          liveMessageCount: data.liveMessageCount,
          retainedMessageCount: data.retainedMessageCount,
          hasLiveMessages: data.hasLiveMessages,
          confidence: confidence,
          confidenceReason: confidenceReason,
          isCompoundTopic: data.isCompoundTopic || false,
          compoundFields: data.compoundFields || [],
          lastSeen: data.lastSeen.toISOString(),
          samplePayloads: data.payloads.slice(0, 3), // First 3 payloads for reference
          // ⚠️ Warning for retained-only topics
          ...((!data.hasLiveMessages && data.retainedMessageCount > 0) && {
            warning: 'Only retained messages observed - publisher may be offline. Verify device is active before enabling.'
          }),
          // ⚠️ Warning for mostly-retained topics
          ...((data.hasLiveMessages && data.retainedMessageCount > data.liveMessageCount * 3) && {
            warning: `Mostly retained messages (${data.retainedMessageCount} retained vs ${data.liveMessageCount} live) - publisher may be sporadic or recently restarted.`
          })
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
      component: LogComponents.discovery + "] [" + this.protocol as any,
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

      // Subscribe and collect messages (flexible strategy)
      // Accept ≥1 message for low-rate publishers (every 60s, on-change only, etc.)
      // Don't fail on silence - report observed publish rate instead
      const messages: Array<{ payload: string; isRetained: boolean; timestamp: number }> = [];
      const minMessages = 1;   // Minimum for successful validation
      const maxMessages = 10;  // Ideal target (may not reach with slow publishers)
      const timeout = 15000;   // 15s max wait
      const startTime = Date.now();

      await new Promise<void>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          client.end(true);
          
          // ✅ Accept validation if we got at least 1 message (even if slow publisher)
          // ❌ Don't fail healthy devices that publish every 60s or on-change
          if (messages.length >= minMessages) {
            this.logger?.debugSync(`Validation timeout reached with ${messages.length} messages (acceptable for low-rate publisher)`, {
              component: LogComponents.discovery + "] [" + this.protocol as any,
              topic
            });
            resolve(); // Partial validation OK
          } else {
            // Only fail if truly no messages (likely wrong topic or device offline)
            reject(new Error('No messages received during validation - topic may be inactive or device offline'));
          }
        }, timeout);

        client.subscribe(topic, { qos: 0 }, (err) => {
          if (err) {
            clearTimeout(timeoutHandle);
            reject(err);
          }
        });

        client.on('message', (receivedTopic, payload, packet) => {
          if (receivedTopic === topic) {
            messages.push({
              payload: payload.toString(),
              isRetained: packet.retain,
              timestamp: Date.now()
            });

            // Exit early if we reach target message count
            if (messages.length >= maxMessages) {
              clearTimeout(timeoutHandle);
              client.end(true);
              resolve();
            }
          }
        });
      });

      // Analyze messages for consistency and retained status
      const dataTypes = new Set<string>();
      let liveCount = 0;
      let retainedCount = 0;
      
      for (const msg of messages) {
        dataTypes.add(this.inferDataType(msg.payload));
        if (msg.isRetained) {
          retainedCount++;
        } else {
          liveCount++;
        }
      }

      const isConsistent = dataTypes.size === 1;
      const hasLiveMessages = liveCount > 0;
      
      // Calculate observed publish rate (for non-retained messages)
      const validationDuration = Date.now() - startTime;
      let observedPublishRate: number | undefined;
      let estimatedIntervalMs: number | undefined;
      
      if (liveCount >= 2) {
        // Calculate average interval between live messages
        const liveMessages = messages.filter(m => !m.isRetained);
        const intervals: number[] = [];
        for (let i = 1; i < liveMessages.length; i++) {
          intervals.push(liveMessages[i].timestamp - liveMessages[i - 1].timestamp);
        }
        estimatedIntervalMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        observedPublishRate = 1000 / estimatedIntervalMs; // messages per second
      } else if (liveCount === 1) {
        // Only one live message - can't calculate rate
        observedPublishRate = undefined;
        estimatedIntervalMs = undefined;
      }

      this.logger?.infoSync(`Validation complete for ${topic}`, {
        component: LogComponents.discovery + "] [" + this.protocol as any,
        messageCount: messages.length,
        liveCount,
        retainedCount,
        hasLiveMessages,
        isConsistent,
        dataTypes: Array.from(dataTypes),
        observedPublishRate: observedPublishRate ? `${observedPublishRate.toFixed(3)} msg/s` : 'unknown',
        estimatedInterval: estimatedIntervalMs ? `${Math.round(estimatedIntervalMs)}ms` : 'unknown',
        validationDuration: `${validationDuration}ms`
      });

      return {
        deviceInfo: {
          name: device.name,
          address: topic,
          messageCount: messages.length,
          liveMessageCount: liveCount,
          retainedMessageCount: retainedCount,
          hasLiveMessages,
          dataTypeConsistency: isConsistent,
          observedDataTypes: Array.from(dataTypes),
          observedPublishRate: observedPublishRate ? `${observedPublishRate.toFixed(3)} msg/s` : 'unknown',
          estimatedPublishIntervalMs: estimatedIntervalMs ? Math.round(estimatedIntervalMs) : undefined,
          validationDurationMs: validationDuration,
          publishBehavior: liveCount === 0 ? 'retained-only' : 
                          estimatedIntervalMs && estimatedIntervalMs > 30000 ? 'low-rate' :
                          estimatedIntervalMs && estimatedIntervalMs < 1000 ? 'high-rate' : 'normal'
        },
        manufacturer: hasLiveMessages ? 'Active MQTT Publisher' : 'Unknown MQTT Publisher (retained only)',
        modelNumber: 'MQTT',
        capabilities: ['readable'] // Discovery confirms readable capability
      };

    } catch (error) {
      this.logger?.errorSync(
        `Validation failed for ${topic}`,
        error as Error,
        { component: LogComponents.discovery + "] [" + this.protocol as any }
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
  /**
   * Check if MQTT client library is available
   * 
   * NOTE: We only check library availability here, not broker connectivity.
   * Actual broker connection is tested during discover() phase with the
   * correct broker URL from target state configuration.
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Just check if mqtt library is available
      await import('mqtt');
      return true;
    } catch {
      return false;
    }
  }
}







