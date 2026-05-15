import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { normalizeDeviceState } from './device-state';
import type {
	CanonicalDeviceState,
	DataPoint,
	MetricConfig,
	Protocol,
} from './types';

export function getMetricConfig(
	metrics: readonly MetricConfig[],
	metricName: string,
): MetricConfig | undefined {
	const exact = metrics.find((metric) => metric.name === metricName);
	if (exact) {
		return exact;
	}

	for (const metric of metrics) {
		if (metric.deviceName && `${metric.deviceName}_${metric.name}` === metricName) {
			return metric;
		}
	}

	const systemPrefixMatch = metricName.match(/^[0-9a-f-]{36}_system_(.+)$/);
	if (systemPrefixMatch) {
		const bareName = systemPrefixMatch[1];
		const bare = metrics.find((metric) => metric.name === bareName);
		if (bare) {
			return bare;
		}
	}

	const endpointPrefixMatch = metricName.match(/^[0-9a-f-]{36}_[0-9a-f-]{36}_(.+)$/);
	if (endpointPrefixMatch) {
		const bareName = endpointPrefixMatch[1];
		const bare = metrics.find((metric) => metric.name === bareName);
		if (bare) {
			return bare;
		}
	}

	return undefined;
}

export function resolveDeviceState(
	dataPoint: DataPoint,
	fallbackProtocol?: Protocol,
): CanonicalDeviceState {
	const protocol = dataPoint.protocol || fallbackProtocol || 'system';
	const candidate =
		dataPoint.deviceState ??
		dataPoint.rawDeviceState ??
		dataPoint.tags?.deviceState ??
		dataPoint.tags?.state;

	if (candidate === undefined || candidate === null) {
		if (protocol === 'opcua') {
			if (dataPoint.quality === 'GOOD') {
				return 'running';
			}
			if (dataPoint.quality === 'BAD' || dataPoint.quality === 'UNCERTAIN') {
				return 'fault';
			}
		}
	}

	return normalizeDeviceState(protocol, candidate);
}

export function resolveEventDeviceType(
	dataPoint: DataPoint,
	fallbackDeviceType: Protocol | undefined,
	logger?: AgentLogger,
): Protocol {
	if (dataPoint.protocol) {
		return dataPoint.protocol;
	}

	if (dataPoint.source === 'endpoint') {
		const metric = dataPoint.metric.toLowerCase();
		if (metric.includes('modbus')) return 'modbus';
		if (metric.includes('opcua')) return 'opcua';
		if (metric.includes('bacnet')) return 'bacnet';
		if (metric.includes('mqtt')) return 'mqtt';

		const canonicalEndpointMetric = /^[0-9a-f-]{36}_[0-9a-f-]{36}_.+$/i.test(dataPoint.metric);
		if (canonicalEndpointMetric && !dataPoint.protocol) {
			logger?.warnSync('Canonical endpoint metric without explicit protocol, defaulting to mqtt', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				source: dataPoint.source,
			});
			return 'mqtt';
		}
	}

	logger?.debugSync('Resolving device type to fallback', {
		component: LogComponents.anomaly,
		metric: dataPoint.metric,
		source: dataPoint.source,
		hasProtocol: !!dataPoint.protocol,
		fallbackDeviceType: fallbackDeviceType || 'system',
	});
	return fallbackDeviceType || 'system';
}

export function resolveDeviceId(dataPoint: DataPoint): string {
	const candidate =
		dataPoint.deviceId ??
		dataPoint.tags?.deviceId ??
		dataPoint.tags?.endpointId ??
		dataPoint.tags?.containerId ??
		dataPoint.tags?.deviceUuid;

	if (typeof candidate === 'string' && candidate.trim().length > 0) {
		return candidate.trim();
	}

	if (dataPoint.source === 'system') {
		return 'system-endpoint';
	}

	if (dataPoint.source === 'container') {
		return 'unknown-container';
	}

	return 'unknown-device';
}

export function getBufferKey(
	metricName: string,
	deviceState: CanonicalDeviceState,
	deviceId: string,
): string {
	return `${deviceId}::${deviceState}::${metricName}`;
}

export function parseBufferKey(
	bufferKey: string,
): { metricName: string; deviceState: CanonicalDeviceState; deviceId: string } {
	const lastSeparator = bufferKey.lastIndexOf('::');
	if (lastSeparator === -1) {
		return { metricName: bufferKey, deviceState: 'unknown', deviceId: 'unknown' };
	}

	const secondLastSeparator = bufferKey.lastIndexOf('::', lastSeparator - 1);
	if (secondLastSeparator === -1) {
		const metricName = bufferKey.slice(0, lastSeparator);
		const state = bufferKey.slice(lastSeparator + 2) as CanonicalDeviceState;
		return {
			metricName,
			deviceState: state || 'unknown',
			deviceId: 'unknown',
		};
	}

	const deviceId = bufferKey.slice(0, secondLastSeparator) || 'unknown';
	const state = bufferKey.slice(secondLastSeparator + 2, lastSeparator) as CanonicalDeviceState;
	const metricName = bufferKey.slice(lastSeparator + 2);
	return {
		metricName,
		deviceState: state || 'unknown',
		deviceId,
	};
}
