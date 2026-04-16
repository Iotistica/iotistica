import { logger } from '../utils/logger';
import { ReadingInsert } from './readings';
import { DeviceDataEntry, DeviceIdentity } from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNKNOWN_DEVICE_NAME = 'unknown';
// Cache identity extraction per context object (same context reused for all readings in a message).
const _ctxIdentityCache = new WeakMap<object, DeviceIdentity>();
const shortId = (id?: string): string | undefined => id?.substring(0, 8);
const KNOWN_PROTOCOLS = new Set(['modbus', 'opcua', 'snmp', 'can', 'mqtt', 'bacnet', 'system']);

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveEntryDeviceName(entry: DeviceDataEntry): string {
  const directName = normalizeNonEmptyString(entry.deviceName);
  if (directName) return directName;

  const payloadIdentity = extractDeviceIdentity(entry.data);
  if (payloadIdentity.deviceName) return payloadIdentity.deviceName;

  const metadataIdentity = extractDeviceIdentity(entry.metadata);
  if (metadataIdentity.deviceName) return metadataIdentity.deviceName;

  return UNKNOWN_DEVICE_NAME;
}

function normalizeProtocolCandidate(value: unknown): string | undefined {
  const normalized = normalizeNonEmptyString(value)?.toLowerCase();
  if (!normalized) return undefined;
  return KNOWN_PROTOCOLS.has(normalized) ? normalized : undefined;
}

function extractProtocolFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const directProtocol = normalizeProtocolCandidate(record.protocol);
  if (directProtocol) return directProtocol;

  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      const protocol = extractProtocolFromPayload(message);
      if (protocol) return protocol;
    }
  }

  if (Array.isArray(record.readings)) {
    for (const reading of record.readings) {
      const protocol = extractProtocolFromPayload(reading);
      if (protocol) return protocol;
    }
  }

  return undefined;
}

export function detectProtocol(entry: DeviceDataEntry): string {
  const metadataProtocol = normalizeProtocolCandidate(entry.metadata?.protocol);
  if (metadataProtocol) return metadataProtocol;

  const payloadProtocol = extractProtocolFromPayload(entry.data);
  if (payloadProtocol) return payloadProtocol;

  const name = resolveEntryDeviceName(entry).toLowerCase();
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
  entry: DeviceDataEntry,
  ingestedAt: Date,
  identityContext?: Record<string, any>,
): Record<string, any> {
  // Avoid the combined object spread: look up identity fields from both sources directly.
  // payload overrides identityContext (preserving prior spread semantics).
  let ctxId: DeviceIdentity | undefined;
  if (identityContext) {
    ctxId = _ctxIdentityCache.get(identityContext);
    if (!ctxId) {
      ctxId = extractDeviceIdentity(identityContext);
      _ctxIdentityCache.set(identityContext, ctxId);
    }
  }
  const payloadId = payload ? extractDeviceIdentity(payload) : undefined;

  return {
    endpoint_uuid: (payloadId?.endpointUuid ?? ctxId?.endpointUuid) ?? null,
    device_uuid: (payloadId?.deviceUuid ?? ctxId?.deviceUuid) ?? null,
    device_name: (payloadId?.deviceName ?? ctxId?.deviceName) ?? null,
    ingested_at: ingestedAt.toISOString(),
  };
}

function extractAnomalyFields(reading: any): Partial<ReadingInsert> {
  const fields: Partial<ReadingInsert> = {};
  if (typeof reading.anomaly_score === 'number') fields.anomaly_score = reading.anomaly_score;
  if (typeof reading.anomaly_threshold === 'number') fields.anomaly_threshold = reading.anomaly_threshold;
  if (typeof reading.baseline_samples === 'number') fields.baseline_samples = reading.baseline_samples;
  if (reading.detection_methods) {
    fields.detection_methods = reading.detection_methods;
    fields.detectionMethodsJson = JSON.stringify(reading.detection_methods);
  }
  return fields;
}

export function normalizeReading(
  reading: any,
  entry: DeviceDataEntry,
  protocol: string,
  ingestedAt: Date,
  messageTimestamp?: string,
  messageContext?: Record<string, any>,
): ReadingInsert | null {
  const resolvedDeviceName = resolveEntryDeviceName(entry);

  if (reading.nodeType === 'metadata') {
    logger.debug('Skipping metadata node (not stored in readings table)', {
      metric: reading.metric || reading.nodeName || reading.name,
      deviceUuid: shortId(entry.deviceUuid),
      value: reading.value,
    });
    return null;
  }

  const extra = buildExtraPayload(reading, entry, ingestedAt, messageContext);
  return {
    agent_uuid: entry.deviceUuid,
    metric_name: reading.metric || reading.nodeName || reading.name || resolvedDeviceName,
    value: typeof reading.value === 'number' ? reading.value : null,
    quality: normalizeQuality(reading.quality),
    unit: reading.unit || null,
    protocol,
    extra,
    extraJson: JSON.stringify(extra),
    time: new Date(reading.timestamp || messageTimestamp || entry.timestamp),
    ...extractAnomalyFields(reading),
  };
}

// Format 1: {messages: [{readings: [...]}]}  (OPC UA/Modbus compacted)
function expandFormat1(entry: DeviceDataEntry, protocol: string, ingestedAt: Date): ReadingInsert[] {
  const readings: ReadingInsert[] = [];
  entry.data.messages.forEach((message: any) => {
    if (!message.readings || !Array.isArray(message.readings)) return;
    message.readings.forEach((reading: any) => {
      const normalized = normalizeReading(
        reading, entry, protocol, ingestedAt,
        message.timestamp, message,
      );
      if (normalized) {
        readings.push(normalized);
      }
    });
  });
  return readings;
}

// Format 2: {readings: [...]}  (Modbus/OPC UA batch)
function expandFormat2(entry: DeviceDataEntry, protocol: string, ingestedAt: Date): ReadingInsert[] {
  const readings: ReadingInsert[] = [];
  entry.data.readings.forEach((reading: any) => {
    const normalized = normalizeReading(reading, entry, protocol, ingestedAt, undefined, entry.data);
    if (normalized) readings.push(normalized);
  });
  return readings;
}

// Format 3: single reading (legacy)
function expandFormat3(entry: DeviceDataEntry, protocol: string, ingestedAt: Date): ReadingInsert[] {
  const resolvedDeviceName = resolveEntryDeviceName(entry);

  if (entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)) {
    const normalized = normalizeReading(entry.data, entry, protocol, ingestedAt, undefined, entry.data);
    if (normalized) {
      return [normalized];
    }
  }

  const value = typeof entry.data === 'object'
    ? (entry.data.value ?? entry.data.rawValue ?? null)
    : entry.data;
  const extra = buildExtraPayload(entry.data, entry, ingestedAt);
  return [{
    agent_uuid: entry.deviceUuid,
    metric_name:
      (entry.data && typeof entry.data === 'object'
        ? (entry.data.metric || entry.data.nodeName || entry.data.name)
        : null)
      || resolvedDeviceName,
    value: typeof value === 'number' ? value : null,
    quality: normalizeQuality(entry.data?.quality),
    unit: entry.data?.unit || null,
    protocol,
    extra,
    extraJson: JSON.stringify(extra),
    time: new Date(entry.timestamp),
  }];
}

export function expandMessages(entry: DeviceDataEntry, protocol: string, ingestedAt: Date): ReadingInsert[] {
  if (entry.data?.messages && Array.isArray(entry.data.messages)) return expandFormat1(entry, protocol, ingestedAt);
  if (entry.data && Array.isArray(entry.data.readings)) return expandFormat2(entry, protocol, ingestedAt);
  return expandFormat3(entry, protocol, ingestedAt);
}
