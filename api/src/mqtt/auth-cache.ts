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
const MQTT_AUTH_CACHE_JITTER_RATIO = 0.1;
const MQTT_AUTH_REGEX_CACHE_MAX_ENTRIES = Math.max(256, Math.floor(MQTT_AUTH_CACHE_MAX_ENTRIES / 2));

function applyTtlJitter(ttlSeconds: number): number {
  const normalizedTtlSeconds = Math.max(1, ttlSeconds);
  const jitterMultiplier = 1 - MQTT_AUTH_CACHE_JITTER_RATIO + (Math.random() * MQTT_AUTH_CACHE_JITTER_RATIO * 2);
  return Math.max(1, Math.round(normalizedTtlSeconds * jitterMultiplier));
}

function touchLruEntry<T>(entries: Map<string, T>, key: string, value: T): void {
  entries.delete(key);
  entries.set(key, value);
}

function evictLeastRecentlyUsed<T>(entries: Map<string, T>, maxEntries: number): void {
  while (entries.size > maxEntries) {
    const oldestKey = entries.keys().next().value;
    if (!oldestKey) {
      return;
    }
    entries.delete(oldestKey);
  }
}

const aclRegexCache = new Map<string, RegExp>();

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
      touchLruEntry(this.entries, key, cached);
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
        touchLruEntry(this.entries, key, {
          expiresAt: Date.now() + applyTtlJitter(ttlSeconds) * 1000,
          value,
        });
        evictLeastRecentlyUsed(this.entries, this.maxEntries);

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

function getOrCreateAclMatcher(topic: string): RegExp | undefined {
  if (!topic.includes('+') && !topic.includes('#')) {
    return undefined;
  }

  const cached = aclRegexCache.get(topic);
  if (cached) {
    touchLruEntry(aclRegexCache, topic, cached);
    return cached;
  }

  const matcher = new RegExp(`^${topic.replace(/\+/g, '[^/]+').replace(/#/g, '.*').replace(/\//g, '\\/')}$`);
  touchLruEntry(aclRegexCache, topic, matcher);
  evictLeastRecentlyUsed(aclRegexCache, MQTT_AUTH_REGEX_CACHE_MAX_ENTRIES);
  return matcher;
}

export function buildCachedAclRule(topic: string, access: number): CachedMqttAclRule {
  const matcher = getOrCreateAclMatcher(topic);

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
  aclRegexCache.clear();
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