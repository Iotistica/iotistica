/**
 * Tenant Resolution Service
 * 
 * Determines which customer/tenant a request belongs to based on:
 * - Subdomain (primary): tenantA.app.com → customer_id
 * - Header fallback (internal only): X-Customer-ID
 * 
 * Caches mappings to avoid repeated lookups
 */

class SimpleCache {
  private store = new Map<string, string>();

  get(key: string): string | undefined {
    return this.store.get(key);
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  flushAll(): void {
    this.store.clear();
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }
}

// In-memory cache for subdomain → customer_id mapping
const subdomainCache = new SimpleCache();

// API and dashboard hostnames often include a service prefix before the tenant label.
// Example: api-client-a1b2c3d4e5f6.iotistica.com -> client-a1b2c3d4e5f6
const SERVICE_PREFIXES = ['api-', 'dashboard-', 'mqtt-', 'grafana-', 'ws-'];

const CUSTOMER_NAMESPACE_RE = /^customer-[a-f0-9]{12}$/i;
const CLIENT_NAMESPACE_RE = /^client-[a-f0-9]{12}$/i;

function normalizeTenantLabel(subdomain: string): string {
  let normalized = subdomain;

  // Strip known service prefixes until we reach the tenant identifier label.
  while (SERVICE_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    const prefix = SERVICE_PREFIXES.find(p => normalized.startsWith(p));
    if (!prefix) {
      break;
    }
    normalized = normalized.substring(prefix.length);
  }

  return normalized;
}

function getSubdomainCandidates(subdomain: string): string[] {
  const normalizedSubdomain = normalizeTenantLabel(subdomain);
  return Array.from(new Set([subdomain, normalizedSubdomain]));
}

function resolveFromNamespacePattern(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const isClientNamespace = CLIENT_NAMESPACE_RE.test(candidate);

    if (isClientNamespace) {
      return candidate;
    }
  }

  return null;
}

/**
 * Resolve customer_id from request hostname
 * 
 * Examples:
 * - customer-a1b2c3.iotistic.cloud → customer_a1b2c3 (direct match)
 * - api-client-a1b2c3d4e5f6.iotistic.cloud → client-a1b2c3d4e5f6 (service prefix normalized)
 * 
 * @throws Error if hostname doesn't match expected pattern or customer not found
 */
export function getTenantIdFromHost(hostname: string): string {
  try {
    // Split hostname into parts: [subdomain, domain, tld] or [subdomain, subdomain2, domain, tld]
    const parts = hostname.toLowerCase().split('.');

    if (parts.length < 3) {
      throw new Error(`Invalid hostname structure: ${hostname} (expected at least 3 parts)`);
    }

    // Extract subdomain (first part)
    const subdomain = parts[0];
    const subdomainCandidates = getSubdomainCandidates(subdomain);
    const normalizedSubdomain = subdomainCandidates[1] || subdomain;

    // Check cache first (both raw and normalized labels)
    for (const candidate of subdomainCandidates) {
      const cached = subdomainCache.get(candidate);
      if (cached) {
        return cached;
      }
    }

    // Resolve by known namespace patterns only.
    // Pattern: customer-{12hex} or client-{12hex}
    const customerId: string | null = resolveFromNamespacePattern(subdomainCandidates);

    if (!customerId) {
      throw new Error(`No customer mapped to subdomain: ${subdomain} (normalized: ${normalizedSubdomain})`);
    }

    // Cache both raw and normalized labels to avoid repeated normalization work.
    for (const candidate of subdomainCandidates) {
      subdomainCache.set(candidate, customerId);
    }

    return customerId;
  } catch (err: any) {
    console.error(`[TenantResolution] Failed to resolve tenant from host ${hostname}:`, err.message);
    throw err;
  }
}

/**
 * Get customer_id from request context (fallback mechanisms)
 * 
 * 1. Try hostname resolution (primary)
 * 2. Fall back to X-Customer-ID header (internal only)
 * 3. Fall back to X-Tenant-ID header (internal only)
 * 4. Fall back to 'test-customer' for localhost (development only)
 */
export function extractTenantId(hostname: string, headers?: Record<string, string>): string {
  try {
    // Primary: hostname
    return getTenantIdFromHost(hostname);
  } catch (hostErr: any) {
    console.debug(`[TenantResolution] Hostname resolution failed, trying fallbacks: ${hostErr.message}`);

    // Fallback 1: X-Customer-ID header (internal tooling only)
    if (headers?.['x-customer-id']) {
      console.debug('[TenantResolution] Using X-Customer-ID header:', headers['x-customer-id']);
      return headers['x-customer-id'];
    }

    // Fallback 2: X-Tenant-ID header (internal tooling only)
    if (headers?.['x-tenant-id']) {
      console.debug('[TenantResolution] Using X-Tenant-ID header:', headers['x-tenant-id']);
      return headers['x-tenant-id'];
    }

    // Fallback 3: localhost development fallback
    if (hostname.startsWith('localhost') || hostname.startsWith('127.0.0.1')) {
      console.debug('[TenantResolution] Localhost detected, using test-customer for development');
      return 'test-customer';
    }

    // No resolution possible
    throw new Error(
      `Cannot determine tenant: invalid hostname (${hostname}) and no X-Customer-ID/X-Tenant-ID header provided`
    );
  }
}

/**
 * Clear subdomain cache (for testing or when mappings change)
 */
export function clearTenantCache(): void {
  subdomainCache.flushAll();
}

/**
 * Get cache stats (for monitoring)
 */
export function getCacheStats(): { keys: number; size: string } {
  const keys = subdomainCache.keys().length;
  return {
    keys,
    size: `${keys} mappings cached`
  };
}
