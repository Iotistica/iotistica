import { createHash, randomUUID } from 'crypto';
import { redisClient } from '../redis/client';
import logger from '../utils/logger';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface CacheLoadResult<T> {
  ttlSeconds: number;
  value: T;
}

interface SharedCacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface SharedCacheAdapter<T> {
  deserialize: (value: unknown) => T | null;
  serialize: (value: T) => unknown;
}

interface SharedCacheContext {
  client: RedisClientLike;
  namespace: string;
}

interface DistributedLoadLock {
  client: RedisClientLike;
  key: string;
  token: string;
}

class CacheLoaderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheLoaderTimeoutError';
  }
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

export interface CachedMqttAclRulesResult {
  error?: string;
  rules: CachedMqttAclRule[];
}

type RedisClientLike = ReturnType<typeof redisClient.getClient>;
type SharedCacheKind = 'user' | 'superuser' | 'acl';

const authCacheLogger = logger.child({ module: 'MqttAuthCache' });

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
const MQTT_AUTH_LOADER_TIMEOUT_MS = readPositiveIntEnv('MQTT_AUTH_LOADER_TIMEOUT_MS', 100);
const MQTT_AUTH_SHARED_CACHE_ENABLED = /^(1|true|yes)$/i.test(process.env.MQTT_AUTH_SHARED_CACHE_ENABLED ?? 'false');
const MQTT_AUTH_SHARED_CACHE_PREFIX = process.env.MQTT_AUTH_SHARED_CACHE_PREFIX?.trim() || 'mqtt-auth-cache:v1';
const MQTT_AUTH_SHARED_CACHE_EPOCH_REFRESH_SECONDS = readPositiveIntEnv('MQTT_AUTH_SHARED_CACHE_EPOCH_REFRESH_SECONDS', 2);
const MQTT_AUTH_SHARED_LOCK_ENABLED = /^(1|true|yes)$/i.test(process.env.MQTT_AUTH_SHARED_LOCK_ENABLED ?? 'true');
const MQTT_AUTH_SHARED_LOCK_TIMEOUT_MS = readPositiveIntEnv('MQTT_AUTH_SHARED_LOCK_TIMEOUT_MS', 250);
const MQTT_AUTH_SHARED_LOCK_WAIT_TIMEOUT_MS = readPositiveIntEnv('MQTT_AUTH_SHARED_LOCK_WAIT_TIMEOUT_MS', 125);
const MQTT_AUTH_SHARED_LOCK_POLL_INTERVAL_MS = readPositiveIntEnv('MQTT_AUTH_SHARED_LOCK_POLL_INTERVAL_MS', 15);
const MQTT_AUTH_CACHE_JITTER_RATIO = 0.1;
const MQTT_AUTH_REGEX_CACHE_MAX_ENTRIES = Math.max(256, Math.floor(MQTT_AUTH_CACHE_MAX_ENTRIES / 2));

let localCacheEpoch = 0;
let cachedSharedEpoch: CacheEntry<string> | null = null;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readDecisionResult(value: unknown): 'allow' | 'deny' | null {
  return value === 'allow' || value === 'deny' ? value : null;
}

function deserializeUserAuthDecision(value: unknown): CachedMqttUserAuthDecision | null {
  if (!isRecord(value)) {
    return null;
  }

  const result = readDecisionResult(value.result);
  if (!result || typeof value.isSuperuser !== 'boolean') {
    return null;
  }

  const error = value.error === undefined ? undefined : readString(value.error);
  if (value.error !== undefined && error === null) {
    return null;
  }

  return {
    error,
    isSuperuser: value.isSuperuser,
    result,
  };
}

function deserializeSuperuserDecision(value: unknown): CachedMqttSuperuserDecision | null {
  return deserializeUserAuthDecision(value);
}

function deserializeAclRulesResult(value: unknown): CachedMqttAclRulesResult | null {
  if (!isRecord(value) || !Array.isArray(value.rules)) {
    return null;
  }

  const rules: CachedMqttAclRule[] = [];

  for (const item of value.rules) {
    if (!isRecord(item) || typeof item.access !== 'number' || typeof item.topic !== 'string') {
      return null;
    }

    rules.push(buildCachedAclRule(item.topic, item.access));
  }

  const error = value.error === undefined ? undefined : readString(value.error);
  if (value.error !== undefined && error === null) {
    return null;
  }

  return {
    error,
    rules,
  };
}

const userAuthCacheAdapter: SharedCacheAdapter<CachedMqttUserAuthDecision> = {
  deserialize: deserializeUserAuthDecision,
  serialize: (value) => value,
};

const superuserCacheAdapter: SharedCacheAdapter<CachedMqttSuperuserDecision> = {
  deserialize: deserializeSuperuserDecision,
  serialize: (value) => value,
};

const aclRulesCacheAdapter: SharedCacheAdapter<CachedMqttAclRulesResult> = {
  deserialize: deserializeAclRulesResult,
  serialize: (value) => ({
    error: value.error,
    rules: value.rules.map((rule) => ({ access: rule.access, topic: rule.topic })),
  }),
};

function buildUsernameKey(username: string): string {
  return createHash('sha256').update(username).digest('hex');
}

function isCacheLoaderTimeoutError(error: unknown): error is CacheLoaderTimeoutError {
  return error instanceof CacheLoaderTimeoutError;
}

// This bounds caller wait time, but it does not guarantee cancellation of the
// underlying loader unless the loader itself supports cancellation.
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  return Promise.race<T>([
    promise,
    new Promise<T>((_, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new CacheLoaderTimeoutError(`MQTT auth cache loader timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise.finally(() => clearTimeout(timeoutHandle)).catch(() => undefined);
    }),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLocalCacheNamespace(): string {
  return `local:${localCacheEpoch}`;
}

async function getSharedRedisClient(): Promise<RedisClientLike | null> {
  if (!MQTT_AUTH_SHARED_CACHE_ENABLED || !redisClient.isReady()) {
    return null;
  }

  try {
    return redisClient.getClient();
  } catch (error) {
    authCacheLogger.debug('Shared MQTT auth cache unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function getSharedCacheNamespace(client: RedisClientLike): Promise<string> {
  const now = Date.now();
  if (cachedSharedEpoch && cachedSharedEpoch.expiresAt > now) {
    return cachedSharedEpoch.value;
  }

  try {
    const epoch = (await client.get(`${MQTT_AUTH_SHARED_CACHE_PREFIX}:epoch`)) ?? '0';
    const namespace = `shared:${epoch}`;
    cachedSharedEpoch = {
      expiresAt: now + MQTT_AUTH_SHARED_CACHE_EPOCH_REFRESH_SECONDS * 1000,
      value: namespace,
    };
    return namespace;
  } catch (error) {
    authCacheLogger.debug('Failed to read shared MQTT auth cache epoch', {
      error: error instanceof Error ? error.message : String(error),
    });
    return getLocalCacheNamespace();
  }
}

async function getSharedCacheContext(): Promise<SharedCacheContext | null> {
  const client = await getSharedRedisClient();
  if (!client) {
    return null;
  }

  const namespace = await getSharedCacheNamespace(client);
  if (namespace === getLocalCacheNamespace()) {
    return null;
  }

  return {
    client,
    namespace,
  };
}

function buildSharedCacheKey(namespace: string, kind: SharedCacheKind, scopeKey: string): string {
  return `${MQTT_AUTH_SHARED_CACHE_PREFIX}:${namespace}:${kind}:${scopeKey}`;
}

function buildSharedLockKey(namespace: string, kind: SharedCacheKind, scopeKey: string): string {
  return `${MQTT_AUTH_SHARED_CACHE_PREFIX}:${namespace}:lock:${kind}:${scopeKey}`;
}

function parseSharedCacheEntry<T>(raw: string, adapter: SharedCacheAdapter<T>): SharedCacheEntry<T> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.expiresAt !== 'number') {
      return null;
    }

    const value = adapter.deserialize(parsed.value);
    if (value === null) {
      return null;
    }

    return {
      expiresAt: parsed.expiresAt,
      value,
    };
  } catch {
    return null;
  }
}

async function readSharedCacheEntry<T>(
  kind: SharedCacheKind,
  scopeKey: string,
  adapter: SharedCacheAdapter<T>,
): Promise<SharedCacheEntry<T> | null> {
  const context = await getSharedCacheContext();
  if (!context) {
    return null;
  }

  const key = buildSharedCacheKey(context.namespace, kind, scopeKey);

  try {
    const raw = await context.client.get(key);
    if (!raw) {
      return null;
    }

    const entry = parseSharedCacheEntry(raw, adapter);
    if (!entry || entry.expiresAt <= Date.now()) {
      void context.client.del(key).catch(() => undefined);
      return null;
    }

    return entry;
  } catch (error) {
    authCacheLogger.debug('Failed to read shared MQTT auth cache entry', {
      error: error instanceof Error ? error.message : String(error),
      kind,
    });
    return null;
  }
}

async function writeSharedCacheEntry<T>(
  kind: SharedCacheKind,
  scopeKey: string,
  entry: SharedCacheEntry<T>,
  adapter: SharedCacheAdapter<T>,
): Promise<void> {
  const context = await getSharedCacheContext();
  if (!context) {
    return;
  }

  const ttlSeconds = Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  const key = buildSharedCacheKey(context.namespace, kind, scopeKey);

  try {
    await context.client.set(
      key,
      JSON.stringify({
        expiresAt: entry.expiresAt,
        value: adapter.serialize(entry.value),
      }),
      'EX',
      ttlSeconds,
    );
  } catch (error) {
    authCacheLogger.debug('Failed to write shared MQTT auth cache entry', {
      error: error instanceof Error ? error.message : String(error),
      kind,
    });
  }
}

async function tryAcquireDistributedLoadLock(
  kind: SharedCacheKind,
  scopeKey: string,
): Promise<DistributedLoadLock | null> {
  if (!MQTT_AUTH_SHARED_LOCK_ENABLED) {
    return null;
  }

  const context = await getSharedCacheContext();
  if (!context) {
    return null;
  }

  const lock = {
    client: context.client,
    key: buildSharedLockKey(context.namespace, kind, scopeKey),
    token: randomUUID(),
  };

  try {
    const result = await context.client.set(lock.key, lock.token, 'PX', MQTT_AUTH_SHARED_LOCK_TIMEOUT_MS, 'NX');
    return result === 'OK' ? lock : null;
  } catch (error) {
    authCacheLogger.debug('Failed to acquire distributed MQTT auth load lock', {
      error: error instanceof Error ? error.message : String(error),
      kind,
    });
    return null;
  }
}

async function releaseDistributedLoadLock(lock: DistributedLoadLock | null): Promise<void> {
  if (!lock) {
    return;
  }

  try {
    await lock.client.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      lock.key,
      lock.token,
    );
  } catch (error) {
    authCacheLogger.debug('Failed to release distributed MQTT auth load lock', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function waitForSharedCacheFill<T>(
  kind: SharedCacheKind,
  scopeKey: string,
  adapter: SharedCacheAdapter<T>,
): Promise<SharedCacheEntry<T> | null> {
  if (!MQTT_AUTH_SHARED_LOCK_ENABLED || MQTT_AUTH_SHARED_LOCK_WAIT_TIMEOUT_MS <= 0) {
    return null;
  }

  const deadline = Date.now() + MQTT_AUTH_SHARED_LOCK_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const entry = await readSharedCacheEntry(kind, scopeKey, adapter);
    if (entry) {
      return entry;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }

    await delay(Math.min(MQTT_AUTH_SHARED_LOCK_POLL_INTERVAL_MS, remainingMs));
  }

  return null;
}

async function invalidateSharedCacheNamespace(): Promise<void> {
  const client = await getSharedRedisClient();
  if (!client) {
    return;
  }

  try {
    const epoch = await client.incr(`${MQTT_AUTH_SHARED_CACHE_PREFIX}:epoch`);
    cachedSharedEpoch = {
      expiresAt: Date.now() + MQTT_AUTH_SHARED_CACHE_EPOCH_REFRESH_SECONDS * 1000,
      value: `shared:${epoch}`,
    };
  } catch (error) {
    cachedSharedEpoch = null;
    authCacheLogger.warn('Failed to invalidate shared MQTT auth cache namespace', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

class InFlightTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries: number) {}

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  async getOrLoad(
    key: string,
    loader: () => Promise<CacheLoadResult<T>>,
    sharedCache?: {
      adapter: SharedCacheAdapter<T>;
      kind: SharedCacheKind;
      scopeKey: string;
    },
  ): Promise<T> {
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

    const resolveValue = (entry: CacheEntry<T>): T => {
      touchLruEntry(this.entries, key, entry);
      evictLeastRecentlyUsed(this.entries, this.maxEntries);
      return entry.value;
    };

    const lookupPromise = (async () => {
      if (sharedCache) {
        const sharedEntry = await readSharedCacheEntry(sharedCache.kind, sharedCache.scopeKey, sharedCache.adapter);
        if (sharedEntry) {
          return resolveValue(sharedEntry);
        }
      }

      let distributedLock: DistributedLoadLock | null = null;
      if (sharedCache) {
        distributedLock = await tryAcquireDistributedLoadLock(sharedCache.kind, sharedCache.scopeKey);

        if (!distributedLock) {
          const sharedEntry = await waitForSharedCacheFill(sharedCache.kind, sharedCache.scopeKey, sharedCache.adapter);
          if (sharedEntry) {
            return resolveValue(sharedEntry);
          }
        }
      }

      const loadPromise = loader();

      return withTimeout(loadPromise, MQTT_AUTH_LOADER_TIMEOUT_MS)
        .then(({ ttlSeconds, value }) => {
          const entry = {
            expiresAt: Date.now() + applyTtlJitter(ttlSeconds) * 1000,
            value,
          };

          if (sharedCache) {
            void writeSharedCacheEntry(sharedCache.kind, sharedCache.scopeKey, entry, sharedCache.adapter);
          }

          return resolveValue(entry);
        })
        .finally(async () => {
          await releaseDistributedLoadLock(distributedLock);
        });
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, lookupPromise);
    return lookupPromise;
  }
}

const mqttUserAuthCache = new InFlightTtlCache<CachedMqttUserAuthDecision>(MQTT_AUTH_CACHE_MAX_ENTRIES);
const mqttSuperuserCache = new InFlightTtlCache<CachedMqttSuperuserDecision>(MQTT_AUTH_CACHE_MAX_ENTRIES);
const mqttAclRulesCache = new InFlightTtlCache<CachedMqttAclRulesResult>(MQTT_AUTH_CACHE_MAX_ENTRIES);

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

export async function clearMqttAuthCaches(): Promise<void> {
  localCacheEpoch += 1;
  cachedSharedEpoch = null;
  mqttUserAuthCache.clear();
  mqttSuperuserCache.clear();
  mqttAclRulesCache.clear();
  aclRegexCache.clear();
  await invalidateSharedCacheNamespace();
}

export function getAllowCacheTtlSeconds(): number {
  return MQTT_AUTH_CACHE_TTL_SECONDS;
}

export function getDenyCacheTtlSeconds(): number {
  return MQTT_AUTH_DENY_CACHE_TTL_SECONDS;
}

export function getAuthLoaderTimeoutMs(): number {
  return MQTT_AUTH_LOADER_TIMEOUT_MS;
}

export async function getCachedMqttUserAuthDecision(
  username: string,
  password: string,
  loader: () => Promise<CacheLoadResult<CachedMqttUserAuthDecision>>,
): Promise<CachedMqttUserAuthDecision> {
  const passwordKey = buildPasswordKey(username, password);
  try {
    return await mqttUserAuthCache.getOrLoad(`user:${passwordKey}`, loader, {
      adapter: userAuthCacheAdapter,
      kind: 'user',
      scopeKey: passwordKey,
    });
  } catch (error) {
    if (isCacheLoaderTimeoutError(error)) {
      authCacheLogger.warn('MQTT user auth loader timed out, denying request', {
        timeoutMs: MQTT_AUTH_LOADER_TIMEOUT_MS,
        username,
      });
      return { error: 'Authentication backend timeout', isSuperuser: false, result: 'deny' };
    }

    throw error;
  }
}

export async function getCachedMqttSuperuserDecision(
  username: string,
  loader: () => Promise<CacheLoadResult<CachedMqttSuperuserDecision>>,
): Promise<CachedMqttSuperuserDecision> {
  const usernameKey = buildUsernameKey(username);
  try {
    return await mqttSuperuserCache.getOrLoad(`superuser:${username}`, loader, {
      adapter: superuserCacheAdapter,
      kind: 'superuser',
      scopeKey: usernameKey,
    });
  } catch (error) {
    if (isCacheLoaderTimeoutError(error)) {
      authCacheLogger.warn('MQTT superuser loader timed out, denying request', {
        timeoutMs: MQTT_AUTH_LOADER_TIMEOUT_MS,
        username,
      });
      return { error: 'Authorization backend timeout', isSuperuser: false, result: 'deny' };
    }

    throw error;
  }
}

export async function getCachedMqttAclRules(
  username: string,
  loader: () => Promise<CacheLoadResult<CachedMqttAclRulesResult>>,
): Promise<CachedMqttAclRulesResult> {
  const usernameKey = buildUsernameKey(username);
  try {
    return await mqttAclRulesCache.getOrLoad(`acl:${username}`, loader, {
      adapter: aclRulesCacheAdapter,
      kind: 'acl',
      scopeKey: usernameKey,
    });
  } catch (error) {
    if (isCacheLoaderTimeoutError(error)) {
      authCacheLogger.warn('MQTT ACL loader timed out, denying request', {
        timeoutMs: MQTT_AUTH_LOADER_TIMEOUT_MS,
        username,
      });
      return {
        error: 'ACL backend timeout',
        rules: [],
      };
    }

    throw error;
  }
}