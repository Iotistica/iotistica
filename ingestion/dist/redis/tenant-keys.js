"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeTenantId = normalizeTenantId;
exports.tenantPrefix = tenantPrefix;
exports.agentStateChannel = agentStateChannel;
exports.agentMetricsChannel = agentMetricsChannel;
exports.agentMetricsPattern = agentMetricsPattern;
exports.metricsStreamKey = metricsStreamKey;
exports.metricsStreamScanPattern = metricsStreamScanPattern;
exports.parseMetricsStreamKey = parseMetricsStreamKey;
exports.uuidFromMetricsStreamKey = uuidFromMetricsStreamKey;
exports.parseMetricsChannel = parseMetricsChannel;
exports.uuidFromMetricsChannel = uuidFromMetricsChannel;
exports.deviceLogsStreamKey = deviceLogsStreamKey;
exports.agentDevicesIngestionStreamKey = agentDevicesIngestionStreamKey;
exports.parseAgentDevicesIngestionStreamKey = parseAgentDevicesIngestionStreamKey;
exports.agentDevicesReadyStreamKey = agentDevicesReadyStreamKey;
exports.agentDevicesDlqStreamKey = agentDevicesDlqStreamKey;
exports.consumerGroupName = consumerGroupName;
exports.consumerName = consumerName;
function normalizeTenantId(tenantId) {
    if (!tenantId || tenantId.trim() === '') {
        throw new Error('Redis tenant key error: tenantId is required');
    }
    const trimmed = tenantId.trim();
    const unwrapped = trimmed.replace(/^\{(.+)\}$/, '$1');
    return unwrapped.replace(/^(cust_|tenant_)/, '');
}
function tenantPrefix(tenantId) {
    return `tenant:{${normalizeTenantId(tenantId)}}`;
}
function agentStateChannel(tenantId, deviceUuid) {
    return `${tenantPrefix(tenantId)}:device:${deviceUuid}:state`;
}
function agentMetricsChannel(tenantId, deviceUuid) {
    return `${tenantPrefix(tenantId)}:device:${deviceUuid}:metrics`;
}
function agentMetricsPattern(tenantId) {
    return `${tenantPrefix(tenantId)}:device:*:metrics`;
}
function metricsStreamKey(tenantId, deviceUuid) {
    return `${tenantPrefix(tenantId)}:metrics:${deviceUuid}`;
}
function metricsStreamScanPattern(tenantId) {
    return `${tenantPrefix(tenantId)}:metrics:*`;
}
function parseMetricsStreamKey(streamKey) {
    const match = streamKey.match(/^tenant:\{([^}]+)\}:metrics:(.+)$/);
    if (!match) {
        throw new Error(`Cannot parse stream key: "${streamKey}" does not match format tenant:{tenantId}:metrics:{uuid}`);
    }
    return { tenantId: normalizeTenantId(match[1]), uuid: match[2] };
}
function uuidFromMetricsStreamKey(streamKey) {
    return parseMetricsStreamKey(streamKey).uuid;
}
function parseMetricsChannel(channel) {
    const match = channel.match(/^tenant:\{([^}]+)\}:device:([^:]+):metrics$/);
    if (!match) {
        throw new Error(`Cannot parse channel: "${channel}" does not match format tenant:{tenantId}:device:{uuid}:metrics`);
    }
    return { tenantId: normalizeTenantId(match[1]), uuid: match[2] };
}
function uuidFromMetricsChannel(channel) {
    return parseMetricsChannel(channel).uuid;
}
function deviceLogsStreamKey(tenantId) {
    return `${tenantPrefix(tenantId)}:device:logs`;
}
function agentDevicesIngestionStreamKey(tenantId) {
    return `${tenantPrefix(tenantId)}:agent:devices:ingestion`;
}
function parseAgentDevicesIngestionStreamKey(streamKey) {
    const match = streamKey.match(/^tenant:\{([^}]+)\}:agent:devices:ingestion$/);
    if (!match) {
        throw new Error(`Cannot parse ingestion stream key: "${streamKey}" does not match format tenant:{tenantId}:agent:devices:ingestion`);
    }
    return { tenantId: normalizeTenantId(match[1]) };
}
function agentDevicesReadyStreamKey(tenantId) {
    return `${tenantPrefix(tenantId)}:agent:devices:ready`;
}
function agentDevicesDlqStreamKey(tenantId) {
    return `${tenantPrefix(tenantId)}:agent:devices:dlq`;
}
function consumerGroupName(tenantId, groupName) {
    return `${normalizeTenantId(tenantId)}:${groupName}`;
}
function consumerName(tenantId, workerName) {
    return `${normalizeTenantId(tenantId)}:${workerName}`;
}
//# sourceMappingURL=tenant-keys.js.map