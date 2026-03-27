export interface ParsedMqttTopic {
  tenantId: string;
  agentUuid: string;
  messageType: string;
  subTopic?: string;
  rest: string[];
}

/**
 * Build tenant-aware MQTT topic: iot/{tenantId}/agent/{agentUuid}/...
 */
export function mqttDeviceTopic(tenantId: string, agentUuid: string, ...segments: string[]): string {
  return ['iot', tenantId, 'agent', agentUuid, ...segments].join('/');
}

/**
 * Build tenant-aware wildcard pattern for subscriptions.
 */
export function mqttDevicePattern(tenantPattern: string, agentPattern: string, ...segments: string[]): string {
  return ['iot', tenantPattern, 'agent', agentPattern, ...segments].join('/');
}

/**
 * Parse MQTT topic: iot/{tenantId}/agent/{agentUuid}/{type}/...
 */
export function parseMqttTopic(topic: string): ParsedMqttTopic | null {
  const parts = topic.split('/');
  
  // Require: iot/{tenantId}/agent/{uuid}/{type}/...
  if (parts.length < 5 || parts[0] !== 'iot' || parts[2] !== 'agent') {
    return null;
  }
  
  return {
    tenantId: parts[1],
    agentUuid: parts[3],
    messageType: (parts[4] || '').toLowerCase(),
    subTopic: parts.length > 5 ? parts[5] : undefined,
    rest: parts.slice(5),
  };
}
