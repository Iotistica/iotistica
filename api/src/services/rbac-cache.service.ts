/**
 * RBAC Cache Service
 * 
 * Caches user roles and tenant status fetched from provisioning API
 * Smart TTL: min(5 minutes, JWT expiry time)
 * 
 * Cache key: sha256(auth0_sub + customer_id)
 * 
 * Failure modes:
 * - If provisioning unreachable and cache empty: REJECT (deny by default)
 * - If provisioning unreachable but cache hit: ALLOW (graceful degradation)
 */

import crypto from 'crypto';
import axios, { AxiosError } from 'axios';

class SimpleCache<T> {
  private store = new Map<string, T>();

  get<K extends T>(key: string): K | undefined {
    return this.store.get(key) as K | undefined;
  }

  set(key: string, value: T): void {
    this.store.set(key, value);
  }

  del(key: string): void {
    this.store.delete(key);
  }

  flushAll(): void {
    this.store.clear();
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }
}

interface RoleAndStatus {
  auth0_sub: string;
  customer_id: string;
  role: string;
  customer_status: 'active' | 'suspended' | 'provisioning';
  last_updated_at: string;
  role_assigned_at?: string;
}

interface CacheEntry {
  data: RoleAndStatus;
  fetched_at: number;  // Unix timestamp
  expires_at: number;  // Unix timestamp
}

// In-memory cache with manual TTL handling (managed per entry)
const rbacCache = new SimpleCache<CacheEntry>();

const PROVISIONING_API_URL = process.env.PROVISIONING_API_URL || 'http://provisioning:3100';
const INTERNAL_AUTH_TOKEN = process.env.INTERNAL_AUTH_TOKEN || '';
const DEFAULT_CACHE_TTL_SECONDS = parseInt(process.env.RBAC_CACHE_TTL_SECONDS || '300', 10); // 5 min default

/**
 * Generate cache key from auth0_sub and customer_id
 */
function getCacheKey(auth0_sub: string, customer_id: string): string {
  return crypto
    .createHash('sha256')
    .update(`${auth0_sub}:${customer_id}`)
    .digest('hex');
}

/**
 * Fetch role and status from provisioning API
 * 
 * Throws if:
 * - Provisioning API unreachable
 * - User/tenant not found
 * - Invalid token
 */
async function fetchFromProvisioning(
  auth0_sub: string,
  customer_id: string
): Promise<RoleAndStatus> {
  if (!INTERNAL_AUTH_TOKEN) {
    throw new Error('INTERNAL_AUTH_TOKEN not configured (required for provisioning API calls)');
  }

  try {
    const response = await axios.get(
      `${PROVISIONING_API_URL}/api/internal/users/${auth0_sub}/tenants/${customer_id}/role`,
      {
        headers: {
          'X-Internal-Token': INTERNAL_AUTH_TOKEN,
          'Content-Type': 'application/json'
        },
        timeout: 5000  // 5-second timeout to avoid blocking requests
      }
    );

    if (!response.data?.success || !response.data?.data) {
      throw new Error(`Invalid response from provisioning API: ${JSON.stringify(response.data)}`);
    }

    return response.data.data as RoleAndStatus;
  } catch (error: any) {
    const axiosErr = error as AxiosError;

    if (axiosErr.response?.status === 404) {
      throw new Error(
        `User ${auth0_sub} not found in customer ${customer_id} (provisioning returned 404)`
      );
    }

    if (axiosErr.response?.status === 401) {
      throw new Error('Invalid INTERNAL_AUTH_TOKEN (provisioning rejected request)');
    }

    if (axiosErr.code === 'ECONNREFUSED' || axiosErr.code === 'ETIMEDOUT') {
      throw new Error(`Provisioning API unreachable: ${error.message}`);
    }

    throw error;
  }
}

/**
 * Get role and status with caching strategy
 * 
 * @param auth0_sub - Auth0 subject (user ID)
 * @param customer_id - Customer/tenant ID
 * @param jwtExpSeconds - JWT expiry time (Unix timestamp); cache TTL = min(5min, time-to-exp)
 * @returns Role and status from cache or provisioning
 * @throws Error if role not found and no cache available
 */
export async function getRoleAndStatus(
  auth0_sub: string,
  customer_id: string,
  jwtExpSeconds?: number
): Promise<RoleAndStatus> {
  const cacheKey = getCacheKey(auth0_sub, customer_id);
  const now = Date.now() / 1000;  // Unix timestamp in seconds

  // Determine cache TTL: minimum of 5 min and time to JWT expiry
  let ttlSeconds = DEFAULT_CACHE_TTL_SECONDS;
  if (jwtExpSeconds && jwtExpSeconds > now) {
    const timeToExp = jwtExpSeconds - now;
    ttlSeconds = Math.min(ttlSeconds, Math.floor(timeToExp));
  }

  // Check if cached entry still valid
  const cached = rbacCache.get<CacheEntry>(cacheKey);
  if (cached && cached.expires_at > now) {
    console.debug(
      `[RBACCache] HIT: ${auth0_sub} in ${customer_id} (expires in ${Math.round(
        cached.expires_at - now
      )}s)`
    );
    return cached.data;
  }

  if (cached && cached.expires_at <= now) {
    console.debug(`[RBACCache] EXPIRED: ${auth0_sub} in ${customer_id}, refreshing...`);
  } else {
    console.debug(`[RBACCache] MISS: ${auth0_sub} in ${customer_id}, fetching from provisioning...`);
  }

  // Fetch from provisioning
  try {
    const data = await fetchFromProvisioning(auth0_sub, customer_id);

    // Store in cache with computed expiry time
    const expiresAt = now + ttlSeconds;
    rbacCache.set(cacheKey, {
      data,
      fetched_at: now,
      expires_at: expiresAt
    });

    console.info(
      `[RBACCache] FETCHED: ${auth0_sub} in ${customer_id}, cached for ${ttlSeconds}s`
    );
    return data;
  } catch (error: any) {
    console.warn(
      `[RBACCache] FETCH FAILED for ${auth0_sub} in ${customer_id}: ${error.message}`
    );

    // Graceful degradation: if we have a stale cache entry, use it
    if (cached) {
      console.warn(
        `[RBACCache] Using stale cache for ${auth0_sub} in ${customer_id} (` +
        `expired ${Math.round(now - cached.expires_at)}s ago) due to provisioning error`
      );
      return cached.data;
    }

    // No cache available and provisioning failed: DENY by default
    throw new Error(
      `Cannot determine role for ${auth0_sub} in ${customer_id}: ` +
      `provisioning unreachable and no cached role available. Deny by default.`
    );
  }
}

/**
 * Invalidate a specific user's cache entries across all tenants
 * (Called when user's roles change to force refresh)
 */
export function invalidateUserCache(auth0_sub: string, customer_id?: string): void {
  if (customer_id) {
    const cacheKey = getCacheKey(auth0_sub, customer_id);
    rbacCache.del(cacheKey);
    console.info(`[RBACCache] Invalidated: ${auth0_sub} in ${customer_id}`);
  } else {
    // Invalidate all entries for this user across all tenants
    // (requires iterating cache; not implemented yet—can optimize later)
    console.info(`[RBACCache] Full user cache invalidation for ${auth0_sub} requested (not implemented)`);
  }
}

/**
 * Clear entire cache (for testing or emergency scenarios)
 */
export function clearRBACCache(): void {
  rbacCache.flushAll();
  console.warn('[RBACCache] Cache cleared');
}

/**
 * Get cache statistics for monitoring
 */
export function getRBACCacheStats(): {
  entries: number;
  hit_rate: string;
  size: string;
} {
  const keys = rbacCache.keys();
  return {
    entries: keys.length,
    hit_rate: 'N/A (implement hit counter if needed)',
    size: `${keys.length} entries cached`
  };
}
