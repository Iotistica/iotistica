import { logger } from '../../utils/logger';
import { ReadingInsert } from '../../services/readings.service';
import { SensorDataEntry, DeviceIdentity } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const shortId = (id?: string): string | undefined => id?.substring(0, 8);

export function detectProtocol(entry: SensorDataEntry): string {
  if (entry.metadata?.protocol) return entry.metadata.protocol;

  const name = entry.sensorName.toLowerCase();
  if (name === 'modbus' || name.startsWith('modbus_')) return 'modbus';
  if (name === 'opcua' || name.startsWith('opcua_')) return 'opcua';
  if (name === 'snmp' || name.startsWith('snmp_')) return 'snmp';
  if (name === 'can' || name.startsWith('can_')) return 'can';

  return 'mqtt';
}

export function normalizeQuality(quality: any): string {
  if (typeof quality === 'string') {
    const q = quality.toLowerCase().trim();
    if (['good', 'bad', 'uncertain', 'stale', 'unknown'].includes(q)) return q;
    if (q.includes('good') || q === 'ok' || q === 'valid') return 'good';
    if (q.includes('uncertain') || q === 'questionable') return 'uncertain';
    if (q.includes('stale') || q === 'old' || q === 'timeout') return 'stale';
    if (q.includes('bad') || q === 'error' || q === 'invalid' || q === 'fail') return 'bad';
    return 'unknown';
  }

  if (typeof quality === 'number') {
    if (quality === 0 || quality === 1) return 'good';
    if ((quality & 0xC0000000) === 0x00000000) return 'good';
    if ((quality & 0xC0000000) === 0x40000000) return 'uncertain';
    if ((quality & 0xC0000000) === 0x80000000) return 'bad';
    if (quality === 0x40940000 || quality === 0x409B0000) return 'stale';
    return quality > 0 ? 'unknown' : 'bad';
  }

  if (quality === true) return 'good';
  if (quality === false) return 'bad';
  if (quality === null || quality === undefined) return 'unknown';

  return 'unknown';
}

/**
 * Extract identity fields from a reading or combined payload.
 * Canonical wire format from the agent:
 *   endpoint_uuid  (snake_case) — explicit endpoint UUID, optional
 *   agent_uuid    (snake_case) — stable asset device UUID
 *   deviceName     (camelCase)  — human-readable device name
 */
export function extractDeviceIdentity(reading: any): DeviceIdentity {
  const pickUuid = (value: any): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null') return undefined;
    return UUID_REGEX.test(trimmed) ? trimmed : undefined;
  };

  const deviceNameRaw =
    typeof reading?.deviceName === 'string'
      ? reading.deviceName
      : (typeof reading?.device_name === 'string' ? reading.device_name : undefined);
  const deviceName = typeof deviceNameRaw === 'string' ? deviceNameRaw.trim() || undefined : undefined;

  const explicitEndpointUuid = pickUuid(reading?.endpoint_uuid) ?? pickUuid(reading?.endpointUuid);
  const explicitDeviceUuid =
    pickUuid(reading?.device_uuid)
    ?? pickUuid(reading?.deviceUuid)
    ?? pickUuid(reading?.asset_uuid);

  return {
    endpointUuid: explicitEndpointUuid,
    deviceUuid: explicitDeviceUuid,
    deviceName,
  };
}

export function buildExtraPayload(
  payload: any,
  entry: SensorDataEntry,
  ingestedAt: Date,
  identityContext?: Record<string, any>,
): Record<string, any> {
  const combined = { ...(identityContext || {}), ...(payload || {}) };
  const { endpointUuid, deviceUuid, deviceName } = extractDeviceIdentity(combined);

  const extra = {
    endpoint_uuid: endpointUuid ?? null,
    device_uuid: deviceUuid ?? null,
    device_name: deviceName ?? null,
    ingested_at: ingestedAt.toISOString(),
  };

  return extra;
}

function extractAnomalyFields(reading: any): Partial<ReadingInsert> {
  const fields: Partial<ReadingInsert> = {};
  if (typeof reading.anomaly_score === 'number') fields.anomaly_score = reading.anomaly_score;
  if (typeof reading.anomaly_threshold === 'number') fields.anomaly_threshold = reading.anomaly_threshold;
  if (typeof reading.baseline_samples === 'number') fields.baseline_samples = reading.baseline_samples;
  if (reading.detection_methods) fields.detection_methods = reading.detection_methods;
  return fields;
}

export function normalizeReading(
  reading: any,
  entry: SensorDataEntry,
  protocol: string,
  ingestedAt: Date,
  messageTimestamp?: string,
  messageContext?: Record<string, any>,
): ReadingInsert | null {
  if (reading.nodeType === 'metadata') {
    logger.debug('Skipping metadata node (not stored in readings table)', {
      metric: reading.metric || reading.nodeName || reading.name,
      deviceUuid: shortId(entry.deviceUuid),
      value: reading.value,
    });
    return null;
  }

  return {
    agent_uuid: entry.deviceUuid,
    metric_name: reading.metric || reading.nodeName || reading.name || entry.sensorName,
    value: typeof reading.value === 'number' ? reading.value : null,
    quality: normalizeQuality(reading.quality),
    unit: reading.unit || null,
    protocol,
    extra: buildExtraPayload(reading, entry, ingestedAt, messageContext),
    time: new Date(reading.timestamp || messageTimestamp || entry.timestamp),
    ...extractAnomalyFields(reading),
  };
}

// Format 1: {messages: [{readings: [...]}]}  (OPC UA/Modbus compacted)
function expandFormat1(entry: SensorDataEntry, protocol: string, ingestedAt: Date): ReadingInsert[] {
  const readings: ReadingInsert[] = [];
  entry.data.messages.forEach((message: any) => {
    if (!message.readings || !Array.isArray(message.readings)) return;
    message.readings.forEach((reading: any) => {
      const normalized = normalizeReading(
        reading, entry, protocol, ingestedAt,
        message.timestamp, { ...(entry.data || {}), ...(message || {}) },
      );
      if (normalized) {
        readings.push(normalized);
      }
    });
  });
  return readings;
}

// Format 2: {readings: [...]}  (Modbus/OPC UA batch)
function expandFormat2(entry: SensorDataEntry, protocol: string, ingestedAt: Date): ReadingInsert[] {
  const readings: ReadingInsert[] = [];
  entry.data.readings.forEach((reading: any) => {
    const normalized = normalizeReading(reading, entry, protocol, ingestedAt, undefined, entry.data);
    if (normalized) readings.push(normalized);
  });
  return readings;
}

// Format 3: single reading (legacy)
function expandFormat3(entry: SensorDataEntry, protocol: string, ingestedAt: Date): ReadingInsert[] {
  if (entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)) {
    const normalized = normalizeReading(entry.data, entry, protocol, ingestedAt, undefined, entry.data);
    if (normalized) {
      return [normalized];
    }
  }

  const value = typeof entry.data === 'object'
    ? (entry.data.value ?? entry.data.rawValue ?? null)
    : entry.data;
  return [{
    agent_uuid: entry.deviceUuid,
    metric_name:
      (entry.data && typeof entry.data === 'object'
        ? (entry.data.metric || entry.data.nodeName || entry.data.name)
        : null)
      || entry.sensorName,
    value: typeof value === 'number' ? value : null,
    quality: normalizeQuality(entry.data?.quality),
    unit: entry.data?.unit || null,
    protocol,
    extra: buildExtraPayload(entry.data, entry, ingestedAt),
    time: new Date(entry.timestamp),
  }];
}

export function expandMessages(entry: SensorDataEntry, protocol: string, ingestedAt: Date): ReadingInsert[] {
  if (entry.data?.messages && Array.isArray(entry.data.messages)) return expandFormat1(entry, protocol, ingestedAt);
  if (entry.data && Array.isArray(entry.data.readings)) return expandFormat2(entry, protocol, ingestedAt);
  return expandFormat3(entry, protocol, ingestedAt);
}
