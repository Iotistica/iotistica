/**
 * Redis Tenant Key Builder
 *
 * MULTI-TENANT SECURITY DESIGN:
 * - All Redis keys use hash tags {tenantId} for Redis Cluster slot optimization
 * - All public functions accept explicit tenantId parameter (no implicit context)
 * - Consumer groups and streams are tenant-scoped to prevent cross-tenant leaks
 * - Pub/Sub channels validated for tenant ownership before processing
 *
 * Key format:   tenant:{tenantId}:<type>:<...>
 * Hash tag:     tenant:{tenantId}:...  (forces same Redis Cluster slot per tenant)
 *
 * Examples:
 *   tenant:{cust_abc123}:device:uuid-1:state
 *   tenant:{cust_abc123}:device:uuid-1:metrics
 *   tenant:{cust_abc123}:device:*:metrics       (wildcard pattern)
 *   tenant:{cust_abc123}:metrics:uuid-1         (stream key)
 *   tenant:{cust_abc123}:metrics:*              (stream scan pattern)
 *   tenant:{cust_abc123}:device:logs            (log stream key)
 *   tenant:{cust_abc123}:device:sensors:ingestion
 *   tenant:{cust_abc123}:device:sensors:ready
 *   tenant:{cust_abc123}:device:sensors:dlq
 *
 * SECURITY NOTES:
 * - Never allow global wildcards (tenant:*:...) - always scope to single tenant
 * - Always validate parsed channel/key matches expected tenant
 * - Consumer groups MUST include tenantId to prevent message stealing
 */

import { LicenseValidator } from '../services/auth/license-validator';

/**
 * Return the validated tenantId or throw.
 * This is the single authoritative source for the tenant identifier.
 * 
 * In single-tenant-per-pod architecture, this extracts the tenantId from the 
 * license JWT validated at startup. Safe to use since namespace isolation ensures
 * each API instance only handles its own tenant.
 */
export function getTenantId(): string {
  const license = LicenseValidator.getInstance().getLicense();
  const { tenantId, customerId } = license as { tenantId?: string; customerId?: string };
  const rawTenantId = tenantId || customerId;
  if (!rawTenantId || rawTenantId.trim() === '') {
    throw new Error('Redis tenant key error: license tenantId is missing or empty');
  }
  return normalizeTenantId(rawTenantId);
}

/**
 * Normalize tenant IDs for Redis key namespace consistency.
 *
 * Examples:
 * - cust_95c7...  -> 95c7...
 * - tenant_95c7... -> 95c7...
 * - {95c7...} -> 95c7...
 */
export function normalizeTenantId(tenantId: string): string {
  if (!tenantId || tenantId.trim() === '') {
    throw new Error('Redis tenant key error: tenantId is required');
  }

  const trimmed = tenantId.trim();
  const unwrapped = trimmed.replace(/^\{(.+)\}$/, '$1');
  return unwrapped.replace(/^(cust_|tenant_)/, '');
}

/**
 * Return the tenant prefix string with hash tag: "tenant:{tenantId}"
 * Hash tags force all tenant keys into same Redis Cluster slot.
 */
export function tenantPrefix(tenantId: string): string {
  return `tenant:{${normalizeTenantId(tenantId)}}`;
}

/**
 * Legacy version - uses global license context
 * @deprecated Use tenantPrefix(tenantId) with explicit parameter
 */
export function tenantPrefixLegacy(): string {
  return tenantPrefix(getTenantId());
}

// ─── Pub/Sub channels ────────────────────────────────────────────────────────

/** 
 * Channel for a specific device's state updates 
 * @param tenantId - Tenant identifier (customerId)
 * @param deviceUuid - Device UUID
 */
export function agentStateChannel(tenantId: string, deviceUuid: string): string {
  return `${tenantPrefix(tenantId)}:device:${deviceUuid}:state`;
}

/** 
 * Channel for a specific device's metrics updates 
 * @param tenantId - Tenant identifier (customerId)
 * @param deviceUuid - Device UUID
 */
export function agentMetricsChannel(tenantId: string, deviceUuid: string): string {
  return `${tenantPrefix(tenantId)}:device:${deviceUuid}:metrics`;
}

/** 
 * Pattern used for psubscribe – matches all device metrics in this tenant 
 * SECURITY: Never use global wildcard tenant:*:device:*:metrics
 * @param tenantId - Tenant identifier (customerId)
 */
export function agentMetricsPattern(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:device:*:metrics`;
}

// ─── Stream keys ─────────────────────────────────────────────────────────────

/** 
 * Stream key for a specific device's metrics 
 * @param tenantId - Tenant identifier (customerId)
 * @param deviceUuid - Device UUID
 */
export function metricsStreamKey(tenantId: string, deviceUuid: string): string {
  return `${tenantPrefix(tenantId)}:metrics:${deviceUuid}`;
}

/** 
 * SCAN MATCH pattern to enumerate all metrics streams for this tenant 
 * SECURITY: Never use global pattern tenant:*:metrics:*
 * @param tenantId - Tenant identifier (customerId)
 */
export function metricsStreamScanPattern(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:metrics:*`;
}

/**
 * Parse metrics stream key and extract tenant + device UUID.
 * SECURITY: Always validate tenant matches expected tenant.
 *
 * Given "tenant:{cust_abc123}:metrics:uuid-1" returns { tenantId: "cust_abc123", uuid: "uuid-1" }
 * Throws if the key does not match the expected format.
 */
export function parseMetricsStreamKey(streamKey: string): { tenantId: string; uuid: string } {
  // Format: tenant:{tenantId}:metrics:{uuid}
  const match = streamKey.match(/^tenant:\{([^}]+)\}:metrics:(.+)$/);
  if (!match) {
    throw new Error(
      `Cannot parse stream key: "${streamKey}" does not match format tenant:{tenantId}:metrics:{uuid}`
    );
  }
  return { tenantId: normalizeTenantId(match[1]), uuid: match[2] };
}

/**
 * Extract the device UUID from a metrics stream key.
 * @deprecated Use parseMetricsStreamKey() to validate tenant
 */
export function uuidFromMetricsStreamKey(streamKey: string): string {
  const parsed = parseMetricsStreamKey(streamKey);
  return parsed.uuid;
}

/**
 * Parse metrics pub/sub channel and extract tenant + device UUID.
 * SECURITY: Always validate tenant matches expected tenant.
 *
 * Given "tenant:{cust_abc123}:device:uuid-1:metrics" returns { tenantId: "cust_abc123", uuid: "uuid-1" }
 * The channel format is: tenant:{tenantId}:device:{uuid}:metrics
 */
export function parseMetricsChannel(channel: string): { tenantId: string; uuid: string } {
  // Format: tenant:{tenantId}:device:{uuid}:metrics
  const match = channel.match(/^tenant:\{([^}]+)\}:device:([^:]+):metrics$/);
  if (!match) {
    throw new Error(
      `Cannot parse channel: "${channel}" does not match format tenant:{tenantId}:device:{uuid}:metrics`
    );
  }
  return { tenantId: normalizeTenantId(match[1]), uuid: match[2] };
}

/**
 * Extract the device UUID from a metrics pub/sub channel.
 * @deprecated Use parseMetricsChannel() to validate tenant
 */
export function uuidFromMetricsChannel(channel: string): string {
  const parsed = parseMetricsChannel(channel);
  return parsed.uuid;
}

// ─── Log stream keys ─────────────────────────────────────────────────────────

/** 
 * Stream key for the device log queue 
 * @param tenantId - Tenant identifier (customerId)
 */
export function deviceLogsStreamKey(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:device:logs`;
}

// ─── Sensor queue stream keys ─────────────────────────────────────────────────

/** 
 * Stream key for the sensor data ingestion queue 
 * @param tenantId - Tenant identifier (customerId)
 */
export function deviceDevicesIngestionStreamKey(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:device:sensors:ingestion`;
}

/** 
 * Stream key for the sensor data processing queue 
 * @param tenantId - Tenant identifier (customerId)
 */
export function deviceDevicesReadyStreamKey(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:device:sensors:ready`;
}

/** 
 * Stream key for the sensor data dead-letter queue 
 * @param tenantId - Tenant identifier (customerId)
 */
export function deviceDevicesDlqStreamKey(tenantId: string): string {
  return `${tenantPrefix(tenantId)}:device:sensors:dlq`;
}

// ─── Consumer Group Helpers ──────────────────────────────────────────────────

/**
 * Generate tenant-scoped consumer group name to prevent cross-tenant message stealing.
 * SECURITY: Consumer groups MUST include tenantId to isolate pending messages.
 * 
 * @param tenantId - Tenant identifier (customerId)
 * @param groupName - Base group name (e.g., 'metrics-writers', 'log-writers')
 * @returns Scoped group name: "{tenantId}:metrics-writers"
 */
export function consumerGroupName(tenantId: string, groupName: string): string {
  return `${normalizeTenantId(tenantId)}:${groupName}`;
}

/**
 * Generate tenant-scoped consumer name for worker identification.
 * SECURITY: Consumer names should include tenantId for audit trails.
 * 
 * @param tenantId - Tenant identifier (customerId)
 * @param workerName - Worker identifier (e.g., 'worker-12345-1699564800000')
 * @returns Scoped consumer name: "{tenantId}:worker-12345-1699564800000"
 */
export function consumerName(tenantId: string, workerName: string): string {
  return `${normalizeTenantId(tenantId)}:${workerName}`;
}
