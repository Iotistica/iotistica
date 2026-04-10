import { createHash } from 'crypto';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface CacheLoadResult<T> {
  ttlSeconds: number;
  value: T;
}

export interface CachedMqttUserAuthDecision {
  error?: string;
  isSuperuser: boolean;
  result: 'allow' | 'deny';
}

export interface CachedMqttSuperuserDecision {
  error?: string;
  isSuperuser: boolean;
  result: 'allow' | 'deny';
}

export interface CachedMqttAclRule {
  access: number;
  matcher?: RegExp;
  topic: string;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MQTT_AUTH_CACHE_TTL_SECONDS = readPositiveIntEnv('MQTT_AUTH_CACHE_TTL_SECONDS', 30);
const MQTT_AUTH_DENY_CACHE_TTL_SECONDS = readPositiveIntEnv('MQTT_AUTH_DENY_CACHE_TTL_SECONDS', 5);
const MQTT_AUTH_CACHE_MAX_ENTRIES = readPositiveIntEnv('MQTT_AUTH_CACHE_MAX_ENTRIES', 5000);

class InFlightTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries: number) {}

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  async getOrLoad(key: string, loader: () => Promise<CacheLoadResult<T>>): Promise<T> {
    const now = Date.now();
    const cached = this.entries.get(key);

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    if (cached) {
      this.entries.delete(key);
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const loadPromise = loader()
      .then(({ ttlSeconds, value }) => {
        this.entries.delete(key);
        this.entries.set(key, {
          expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000,
          value,
        });

        if (this.entries.size > this.maxEntries) {
          const oldestKey = this.entries.keys().next().value;
          if (oldestKey) {
            this.entries.delete(oldestKey);
          }
        }

        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, loadPromise);
    return loadPromise;
  }
}

const mqttUserAuthCache = new InFlightTtlCache<CachedMqttUserAuthDecision>(MQTT_AUTH_CACHE_MAX_ENTRIES);
const mqttSuperuserCache = new InFlightTtlCache<CachedMqttSuperuserDecision>(MQTT_AUTH_CACHE_MAX_ENTRIES);
const mqttAclRulesCache = new InFlightTtlCache<CachedMqttAclRule[]>(MQTT_AUTH_CACHE_MAX_ENTRIES);

function buildPasswordKey(username: string, password: string): string {
  return createHash('sha256').update(username).update('\u0000').update(password).digest('hex');
}

export function buildCachedAclRule(topic: string, access: number): CachedMqttAclRule {
  const matcher = topic.includes('+') || topic.includes('#')
    ? new RegExp(`^${topic.replace(/\+/g, '[^/]+').replace(/#/g, '.*').replace(/\//g, '\\/')}$`)
    : undefined;

  return {
    access,
    matcher,
    topic,
  };
}

export function clearMqttAuthCaches(): void {
  mqttUserAuthCache.clear();
  mqttSuperuserCache.clear();
  mqttAclRulesCache.clear();
}

export function getAllowCacheTtlSeconds(): number {
  return MQTT_AUTH_CACHE_TTL_SECONDS;
}

export function getDenyCacheTtlSeconds(): number {
  return MQTT_AUTH_DENY_CACHE_TTL_SECONDS;
}

export async function getCachedMqttUserAuthDecision(
  username: string,
  password: string,
  loader: () => Promise<CacheLoadResult<CachedMqttUserAuthDecision>>,
): Promise<CachedMqttUserAuthDecision> {
  return mqttUserAuthCache.getOrLoad(`user:${buildPasswordKey(username, password)}`, loader);
}

export async function getCachedMqttSuperuserDecision(
  username: string,
  loader: () => Promise<CacheLoadResult<CachedMqttSuperuserDecision>>,
): Promise<CachedMqttSuperuserDecision> {
  return mqttSuperuserCache.getOrLoad(`superuser:${username}`, loader);
}

export async function getCachedMqttAclRules(
  username: string,
  loader: () => Promise<CacheLoadResult<CachedMqttAclRule[]>>,
): Promise<CachedMqttAclRule[]> {
  return mqttAclRulesCache.getOrLoad(`acl:${username}`, loader);
}