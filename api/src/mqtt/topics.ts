import { encodeIfUuid, decodeUuid, isEncodedUuid, isEncodedHexId, decodeHexId } from './codec';

export interface ParsedMqttTopic {
  tenantId: string;
  agentUuid: string;
  messageType: string;
  subTopic?: string;
  rest: string[];
}

/**
 * Build tenant-aware MQTT topic: i/{encodedTenant}/a/{encodedAgent}/...
 * UUIDs are automatically encoded; wildcards (+, #) pass through unchanged.
 */
export function mqttDeviceTopic(tenantId: string, agentUuid: string, ...segments: string[]): string {
  return ['i', encodeIfUuid(tenantId), 'a', encodeIfUuid(agentUuid), ...segments].join('/');
}

/**
 * Build tenant-aware wildcard pattern for subscriptions.
 * UUIDs are auto-encoded; MQTT wildcards pass through unchanged.
 */
export function mqttDevicePattern(tenantPattern: string, agentPattern: string, ...segments: string[]): string {
  return ['i', encodeIfUuid(tenantPattern), 'a', encodeIfUuid(agentPattern), ...segments].join('/');
}

/**
 * Parse MQTT topic: i/{encodedTenant}/a/{encodedAgent}/{type}/...
 * Decodes encoded UUIDs so downstream handlers work with standard UUIDs.
 */
export function parseMqttTopic(topic: string): ParsedMqttTopic | null {
  const parts = topic.split('/');

  if (parts.length < 5 || parts[0] !== 'i' || parts[2] !== 'a') {
    return null;
  }

  let tenantId = parts[1];
  let agentUuid = parts[3];

  if (isEncodedHexId(tenantId)) {
    try { tenantId = decodeHexId(tenantId); } catch { /* pass through */ }
  }
  if (isEncodedUuid(agentUuid)) {
    try { agentUuid = decodeUuid(agentUuid); } catch { /* pass through */ }
  }

  return {
    tenantId,
    agentUuid,
    messageType: (parts[4] || '').toLowerCase(),
    subTopic: parts.length > 5 ? parts[5] : undefined,
    rest: parts.slice(5),
  };
}
