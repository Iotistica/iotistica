export interface ParsedMqttTopic {
  tenantId: string;
  deviceUuid: string;
  messageType: string;
  rest: string[];
}

/**
 * Build tenant-aware MQTT topic: iot/{tenantId}/device/{deviceUuid}/...
 */
export function mqttDeviceTopic(tenantId: string, deviceUuid: string, ...segments: string[]): string {
  return ['iot', tenantId, 'device', deviceUuid, ...segments].join('/');
}

/**
 * Build tenant-aware wildcard pattern for subscriptions.
 */
export function mqttDevicePattern(tenantPattern: string, devicePattern: string, ...segments: string[]): string {
  return ['iot', tenantPattern, 'device', devicePattern, ...segments].join('/');
}

/**
 * Parse MQTT topic: iot/{tenantId}/device/{deviceUuid}/{type}/...
 */
export function parseMqttTopic(topic: string): ParsedMqttTopic | null {
  const parts = topic.split('/');
  
  // Require: iot/{tenantId}/device/{uuid}/{type}/...
  if (parts.length < 5 || parts[0] !== 'iot' || parts[2] !== 'device') {
    return null;
  }
  
  return {
    tenantId: parts[1],
    deviceUuid: parts[3],
    messageType: (parts[4] || '').toLowerCase(),
    rest: parts.slice(5),
  };
}
