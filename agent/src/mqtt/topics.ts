/**
 * Agent MQTT topic helpers.
 * Topic convention: iot/{tenantId}/agent/{agentUuid}/...
 */

export const MQTT_TOPIC_PATTERNS = {
  tenantScopedRoot: 'iot/{tenantId}/agent/{agentUuid}/...',
  tenantScopedEndpoints: 'iot/{tenantId}/agent/{agentUuid}/endpoints/{topic}'
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

export function agentTopic(agentUuid: string, ...segments: string[]): string {
  return ['iot', getTenantId(), 'agent', agentUuid, ...segments].join('/');
}
