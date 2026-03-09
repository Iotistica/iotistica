/**
 * Redis Tenant Key Builder
 *
 * All Redis keys are prefixed with the tenant identifier derived exclusively from
 * the validated license customerId. No fallbacks are permitted; if the license is
 * not initialized the helpers throw immediately.
 *
 * Key format:   tenant:{customerId}:<type>:<...>
 *
 * Examples:
 *   tenant:cust_abc123:device:uuid-1:state
 *   tenant:cust_abc123:device:uuid-1:metrics
 *   tenant:cust_abc123:device:*:metrics       (wildcard pattern)
 *   tenant:cust_abc123:metrics:uuid-1         (stream key)
 *   tenant:cust_abc123:metrics:*              (stream scan pattern)
 *   tenant:cust_abc123:device:logs            (log stream key)
 *   tenant:cust_abc123:device:sensors:ingestion
 *   tenant:cust_abc123:device:sensors:ready
 *   tenant:cust_abc123:device:sensors:dlq
 */

import { LicenseValidator } from '../services/license-validator';

/**
 * Return the validated customerId or throw.
 * This is the single authoritative source for the tenant identifier.
 */
export function getCustomerId(): string {
  const license = LicenseValidator.getInstance().getLicense();
  const { customerId } = license;
  if (!customerId || customerId.trim() === '') {
    throw new Error('Redis tenant key error: license customerId is missing or empty');
  }
  return customerId;
}

/**
 * Return the tenant prefix string: "tenant:{customerId}"
 */
export function tenantPrefix(): string {
  return `tenant:${getCustomerId()}`;
}

// ─── Pub/Sub channels ────────────────────────────────────────────────────────

/** Channel for a specific device's state updates */
export function deviceStateChannel(deviceUuid: string): string {
  return `${tenantPrefix()}:device:${deviceUuid}:state`;
}

/** Channel for a specific device's metrics updates */
export function deviceMetricsChannel(deviceUuid: string): string {
  return `${tenantPrefix()}:device:${deviceUuid}:metrics`;
}

/** Pattern used for psubscribe – matches all device metrics in this tenant */
export function deviceMetricsPattern(): string {
  return `${tenantPrefix()}:device:*:metrics`;
}

// ─── Stream keys ─────────────────────────────────────────────────────────────

/** Stream key for a specific device's metrics */
export function metricsStreamKey(deviceUuid: string): string {
  return `${tenantPrefix()}:metrics:${deviceUuid}`;
}

/** SCAN MATCH pattern to enumerate all metrics streams for this tenant */
export function metricsStreamScanPattern(): string {
  return `${tenantPrefix()}:metrics:*`;
}

/**
 * Extract the device UUID from a metrics stream key.
 *
 * Given "tenant:cust_abc123:metrics:uuid-1" returns "uuid-1".
 * Throws if the key does not match the expected prefix.
 */
export function uuidFromMetricsStreamKey(streamKey: string): string {
  const prefix = `${tenantPrefix()}:metrics:`;
  if (!streamKey.startsWith(prefix)) {
    throw new Error(
      `Cannot extract UUID: stream key "${streamKey}" does not match expected prefix "${prefix}"`
    );
  }
  return streamKey.slice(prefix.length);
}

/**
 * Extract the device UUID from a metrics pub/sub channel.
 *
 * Given "tenant:cust_abc123:device:uuid-1:metrics" returns "uuid-1".
 * The channel format is: tenant:{customerId}:device:{uuid}:metrics
 */
export function uuidFromMetricsChannel(channel: string): string {
  // Format: tenant:<customerId>:device:<uuid>:metrics
  // Split by ':' gives: ['tenant', customerId, 'device', uuid, 'metrics']
  // uuid is always at index 3 (0-based)
  const parts = channel.split(':');
  if (parts.length < 5 || parts[0] !== 'tenant' || parts[2] !== 'device') {
    throw new Error(
      `Cannot extract UUID: channel "${channel}" does not match expected format`
    );
  }
  return parts[3];
}

// ─── Log stream keys ─────────────────────────────────────────────────────────

/** Stream key for the device log queue */
export function deviceLogsStreamKey(): string {
  return `${tenantPrefix()}:device:logs`;
}

// ─── Sensor queue stream keys ─────────────────────────────────────────────────

/** Stream key for the sensor data ingestion queue */
export function deviceSensorsIngestionStreamKey(): string {
  return `${tenantPrefix()}:device:sensors:ingestion`;
}

/** Stream key for the sensor data processing queue */
export function deviceSensorsReadyStreamKey(): string {
  return `${tenantPrefix()}:device:sensors:ready`;
}

/** Stream key for the sensor data dead-letter queue */
export function deviceSensorsDlqStreamKey(): string {
  return `${tenantPrefix()}:device:sensors:dlq`;
}
