import type { ParsedSourceTopic } from './types.js';

export function parseSourceTopic(sourceTopic: string): ParsedSourceTopic {
	return {
		endpoint: sourceTopic.split('/').pop() || 'telemetry',
		originalTopic: sourceTopic,
	};
}

export function applyTopicTemplate(
	template: string,
	params: { deviceId: string; endpoint: string; topic: string },
): string {
	return template
		.replaceAll('{deviceId}', encodeURIComponent(params.deviceId))
		.replaceAll('{endpoint}', encodeURIComponent(params.endpoint))
		.replaceAll('{topic}', encodeURIComponent(params.topic));
}
