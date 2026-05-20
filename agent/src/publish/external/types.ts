import type { AgentLogger } from '../../logging/agent-logger.js';

export type CloudPublishTarget = 'iotistica' | 'azure' | 'aws' | 'gcp' | 'mqtt';

export interface CloudTargetFactoryInput {
	target?: string;
	logger?: AgentLogger;
}

export interface ParsedSourceTopic {
	endpoint: string;
	originalTopic: string;
}

export function normalizeTarget(target?: string): CloudPublishTarget {
	const value = (target || '').trim().toLowerCase();

	if (value === '' || value === 'iotistica') return 'iotistica';
	if (value === 'azure') return 'azure';
	if (value === 'aws' || value === 'awsiot' || value === 'aws-iot') return 'aws';
	if (value === 'gcp' || value === 'google' || value === 'google-cloud') return 'gcp';
	if (value === 'mqtt' || value === 'external-mqtt' || value === 'generic-mqtt') return 'mqtt';

	// Preserve existing fallback behavior for unknown values.
	return 'iotistica';
}
