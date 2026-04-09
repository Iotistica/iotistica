"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectProtocol = detectProtocol;
exports.normalizeQuality = normalizeQuality;
exports.extractDeviceIdentity = extractDeviceIdentity;
exports.buildExtraPayload = buildExtraPayload;
exports.normalizeReading = normalizeReading;
exports.expandMessages = expandMessages;
const logger_1 = require("../utils/logger");
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNKNOWN_DEVICE_NAME = 'unknown';
const shortId = (id) => id?.substring(0, 8);
const KNOWN_PROTOCOLS = new Set(['modbus', 'opcua', 'snmp', 'can', 'mqtt', 'bacnet', 'system']);
function normalizeNonEmptyString(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
function resolveEntryDeviceName(entry) {
    const directName = normalizeNonEmptyString(entry.deviceName);
    if (directName)
        return directName;
    const payloadIdentity = extractDeviceIdentity(entry.data);
    if (payloadIdentity.deviceName)
        return payloadIdentity.deviceName;
    const metadataIdentity = extractDeviceIdentity(entry.metadata);
    if (metadataIdentity.deviceName)
        return metadataIdentity.deviceName;
    return UNKNOWN_DEVICE_NAME;
}
function normalizeProtocolCandidate(value) {
    const normalized = normalizeNonEmptyString(value)?.toLowerCase();
    if (!normalized)
        return undefined;
    return KNOWN_PROTOCOLS.has(normalized) ? normalized : undefined;
}
function extractProtocolFromPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }
    const record = payload;
    const directProtocol = normalizeProtocolCandidate(record.protocol);
    if (directProtocol)
        return directProtocol;
    if (Array.isArray(record.messages)) {
        for (const message of record.messages) {
            const protocol = extractProtocolFromPayload(message);
            if (protocol)
                return protocol;
        }
    }
    if (Array.isArray(record.readings)) {
        for (const reading of record.readings) {
            const protocol = extractProtocolFromPayload(reading);
            if (protocol)
                return protocol;
        }
    }
    return undefined;
}
function detectProtocol(entry) {
    const metadataProtocol = normalizeProtocolCandidate(entry.metadata?.protocol);
    if (metadataProtocol)
        return metadataProtocol;
    const payloadProtocol = extractProtocolFromPayload(entry.data);
    if (payloadProtocol)
        return payloadProtocol;
    const name = resolveEntryDeviceName(entry).toLowerCase();
    if (name === 'modbus' || name.startsWith('modbus_'))
        return 'modbus';
    if (name === 'opcua' || name.startsWith('opcua_'))
        return 'opcua';
    if (name === 'snmp' || name.startsWith('snmp_'))
        return 'snmp';
    if (name === 'can' || name.startsWith('can_'))
        return 'can';
    return 'mqtt';
}
function normalizeQuality(quality) {
    if (typeof quality === 'string') {
        const q = quality.toLowerCase().trim();
        if (['good', 'bad', 'uncertain', 'stale', 'unknown'].includes(q))
            return q;
        if (q.includes('good') || q === 'ok' || q === 'valid')
            return 'good';
        if (q.includes('uncertain') || q === 'questionable')
            return 'uncertain';
        if (q.includes('stale') || q === 'old' || q === 'timeout')
            return 'stale';
        if (q.includes('bad') || q === 'error' || q === 'invalid' || q === 'fail')
            return 'bad';
        return 'unknown';
    }
    if (typeof quality === 'number') {
        if (quality === 0 || quality === 1)
            return 'good';
        if ((quality & 0xC0000000) === 0x00000000)
            return 'good';
        if ((quality & 0xC0000000) === 0x40000000)
            return 'uncertain';
        if ((quality & 0xC0000000) === 0x80000000)
            return 'bad';
        if (quality === 0x40940000 || quality === 0x409B0000)
            return 'stale';
        return quality > 0 ? 'unknown' : 'bad';
    }
    if (quality === true)
        return 'good';
    if (quality === false)
        return 'bad';
    if (quality === null || quality === undefined)
        return 'unknown';
    return 'unknown';
}
function extractDeviceIdentity(reading) {
    const pickUuid = (value) => {
        if (typeof value !== 'string')
            return undefined;
        const trimmed = value.trim();
        if (!trimmed || trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'null')
            return undefined;
        return UUID_REGEX.test(trimmed) ? trimmed : undefined;
    };
    const deviceNameRaw = typeof reading?.deviceName === 'string'
        ? reading.deviceName
        : (typeof reading?.device_name === 'string' ? reading.device_name : undefined);
    const deviceName = typeof deviceNameRaw === 'string' ? deviceNameRaw.trim() || undefined : undefined;
    const explicitEndpointUuid = pickUuid(reading?.endpoint_uuid) ?? pickUuid(reading?.endpointUuid);
    const explicitDeviceUuid = pickUuid(reading?.device_uuid)
        ?? pickUuid(reading?.deviceUuid)
        ?? pickUuid(reading?.asset_uuid);
    return {
        endpointUuid: explicitEndpointUuid,
        deviceUuid: explicitDeviceUuid,
        deviceName,
    };
}
function buildExtraPayload(payload, entry, ingestedAt, identityContext) {
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
function extractAnomalyFields(reading) {
    const fields = {};
    if (typeof reading.anomaly_score === 'number')
        fields.anomaly_score = reading.anomaly_score;
    if (typeof reading.anomaly_threshold === 'number')
        fields.anomaly_threshold = reading.anomaly_threshold;
    if (typeof reading.baseline_samples === 'number')
        fields.baseline_samples = reading.baseline_samples;
    if (reading.detection_methods) {
        fields.detection_methods = reading.detection_methods;
        fields.detectionMethodsJson = JSON.stringify(reading.detection_methods);
    }
    return fields;
}
function normalizeReading(reading, entry, protocol, ingestedAt, messageTimestamp, messageContext) {
    const resolvedDeviceName = resolveEntryDeviceName(entry);
    if (reading.nodeType === 'metadata') {
        logger_1.logger.debug('Skipping metadata node (not stored in readings table)', {
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
function expandFormat1(entry, protocol, ingestedAt) {
    const readings = [];
    entry.data.messages.forEach((message) => {
        if (!message.readings || !Array.isArray(message.readings))
            return;
        message.readings.forEach((reading) => {
            const normalized = normalizeReading(reading, entry, protocol, ingestedAt, message.timestamp, { ...(entry.data || {}), ...(message || {}) });
            if (normalized) {
                readings.push(normalized);
            }
        });
    });
    return readings;
}
function expandFormat2(entry, protocol, ingestedAt) {
    const readings = [];
    entry.data.readings.forEach((reading) => {
        const normalized = normalizeReading(reading, entry, protocol, ingestedAt, undefined, entry.data);
        if (normalized)
            readings.push(normalized);
    });
    return readings;
}
function expandFormat3(entry, protocol, ingestedAt) {
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
            metric_name: (entry.data && typeof entry.data === 'object'
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
function expandMessages(entry, protocol, ingestedAt) {
    if (entry.data?.messages && Array.isArray(entry.data.messages))
        return expandFormat1(entry, protocol, ingestedAt);
    if (entry.data && Array.isArray(entry.data.readings))
        return expandFormat2(entry, protocol, ingestedAt);
    return expandFormat3(entry, protocol, ingestedAt);
}
//# sourceMappingURL=readings-normalizer.js.map