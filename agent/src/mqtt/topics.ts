/**
 * Agent MQTT topic helpers.
 * Topic convention: iot/{tenantId}/device/{deviceUuid}/...
 */

import { DeviceModel } from '../db/models/device.model';

let cachedTenantId: string | null = null;

/**
 * Initialize tenant ID cache from database.
 * Should be called once during agent startup after database is ready.
 */
export async function initializeTenantId(): Promise<void> {
  try {
    const device = await DeviceModel.get();
    if (device?.tenantId) {
      cachedTenantId = device.tenantId;
    }
  } catch (error) {
    // Database not available yet, will use fallback
  }
}

/**
 * Get tenant ID for MQTT topic construction.
 * Priority:
 * 1. Cached value from previous database lookup or initialization
 * 2. Environment variables (for local dev/testing)
 * 3. Default value 'default' (fallback only)
 * 
 * Note: Database lookup happens during agent startup via initializeTenantId().
 * After provisioning, the cache is automatically populated.
 */
export function getTenantId(): string {
  // Return cached value if available
  if (cachedTenantId) {
    return cachedTenantId;
  }

  // Fallback to environment variables (local dev/testing)
  const envTenantId = 
    process.env.AGENT_TENANT_ID ||
    process.env.IOTISTIC_TENANT_ID ||
    process.env.TENANT_ID;

  if (envTenantId) {
    return envTenantId;
  }

  // Final fallback for local development (agent not provisioned yet)
  return 'default';
}

/**
 * Update cached tenant ID (called automatically after provisioning)
 */
export function setTenantId(tenantId: string): void {
  cachedTenantId = tenantId;
}

/**
 * Reset cached tenant ID (for testing only)
 */
export function resetTenantIdCache(): void {
  cachedTenantId = null;
}

export function deviceTopic(deviceUuid: string, ...segments: string[]): string {
  return ['iot', getTenantId(), 'device', deviceUuid, ...segments].join('/');
}
