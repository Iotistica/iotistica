export function normalizeTenantId(tenantId: string): string {
  if (!tenantId || tenantId.trim() === '') {
    throw new Error('Redis tenant key error: tenantId is required');
  }

  const trimmed = tenantId.trim();
  const unwrapped = trimmed.replace(/^\{(.+)\}$/, '$1');
  return unwrapped.replace(/^(cust_|tenant_)/, '');
}

export function tenantPrefix(tenantId: string): string {
  return `tenant:{${normalizeTenantId(tenantId)}}`;
}

export function agentStateChannel(tenantId: string, deviceUuid: string): string {
  return `${tenantPrefix(tenantId)}:device:${deviceUuid}:state`;
}

export function agentMetricsChannel(tenantId: string, deviceUuid: string): string {
  return `${tenantPrefix(tenantId)}:device:${deviceUuid}:metrics`;
}

export function agentMetricsPattern(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:device:*:metrics`;
}

export function metricsStreamKey(tenantId: string, deviceUuid: string): string {
  return `${tenantPrefix(tenantId)}:metrics:${deviceUuid}`;
}

export function metricsStreamScanPattern(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:metrics:*`;
}

export function parseMetricsStreamKey(streamKey: string): { tenantId: string; uuid: string } {
  const match = streamKey.match(/^tenant:\{([^}]+)\}:metrics:(.+)$/);
  if (!match) {
    throw new Error(`Cannot parse stream key: "${streamKey}" does not match format tenant:{tenantId}:metrics:{uuid}`);
  }
  return { tenantId: normalizeTenantId(match[1]), uuid: match[2] };
}

export function uuidFromMetricsStreamKey(streamKey: string): string {
  return parseMetricsStreamKey(streamKey).uuid;
}

export function parseMetricsChannel(channel: string): { tenantId: string; uuid: string } {
  const match = channel.match(/^tenant:\{([^}]+)\}:device:([^:]+):metrics$/);
  if (!match) {
    throw new Error(`Cannot parse channel: "${channel}" does not match format tenant:{tenantId}:device:{uuid}:metrics`);
  }
  return { tenantId: normalizeTenantId(match[1]), uuid: match[2] };
}

export function uuidFromMetricsChannel(channel: string): string {
  return parseMetricsChannel(channel).uuid;
}

export function deviceLogsStreamKey(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:device:logs`;
}

export function agentDevicesIngestionStreamKey(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:agent:devices:ingestion`;
}

export function parseAgentDevicesIngestionStreamKey(streamKey: string): { tenantId: string } {
  const match = streamKey.match(/^tenant:\{([^}]+)\}:agent:devices:ingestion$/);
  if (!match) {
    throw new Error(
      `Cannot parse ingestion stream key: "${streamKey}" does not match format tenant:{tenantId}:agent:devices:ingestion`
    );
  }
  return { tenantId: normalizeTenantId(match[1]) };
}

export function agentDevicesReadyStreamKey(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:agent:devices:ready`;
}

export function agentDevicesDlqStreamKey(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:agent:devices:dlq`;
}

export function consumerGroupName(tenantId: string, groupName: string): string {
  return `${normalizeTenantId(tenantId)}:${groupName}`;
}

export function consumerName(tenantId: string, workerName: string): string {
  return `${normalizeTenantId(tenantId)}:${workerName}`;
}