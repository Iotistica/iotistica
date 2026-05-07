/**
 * Agent MQTT topic helpers.
 *
 * Topic convention: i/{encodedTenantId}/a/{encodedAgentId}/...
 *   - 'iot' shortened to 'i', 'agent' shortened to 'a'
 *   - UUIDs encoded as Base64 URL-safe (22 chars vs 36 chars)
 */

import { encodeIfUuid } from './codec.js';

export const MQTT_TOPIC_PATTERNS = {
	tenantScopedRoot: 'i/{tenantId}/a/{agentId}/...',
	tenantScopedEndpoints: 'i/{tenantId}/a/{agentId}/d/{endpointId}/+',
} as const;

let cachedTenantId: string | null = null;

/**
 * Get tenant ID for MQTT topic construction.
 * No fallback is allowed. Tenant ID must be set from provisioning response
 * and loaded into cache during agent initialization.
 */
export function getTenantId(): string {
	if (cachedTenantId) {
		return cachedTenantId;
	}

	throw new Error(
		'Tenant ID is not initialized. Agent must be provisioned with tenantId before using MQTT topics.'
	);
}

/**
 * Update cached tenant ID (called automatically after provisioning)
 */
export function setTenantId(tenantId: string): void {
	const normalized = tenantId?.trim();
	if (!normalized) {
		throw new Error('Cannot set empty tenant ID');
	}
	cachedTenantId = normalized;
}

/**
 * Reset cached tenant ID (for testing only)
 */
export function resetTenantIdCache(): void {
	cachedTenantId = null;
}

/**
 * Build an agent-scoped MQTT topic: i/{encodedTenant}/a/{encodedAgent}/...segments
 */
export function agentTopic(agentUuid: string, ...segments: string[]): string {
	const tenantId = getTenantId();
	return ['i', encodeIfUuid(tenantId), 'a', encodeIfUuid(agentUuid), ...segments].join('/');
}
