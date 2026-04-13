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
const MQTT_AUTH_USER_CACHE_TTL_SECONDS = readPositiveIntEnv(
  'MQTT_AUTH_USER_CACHE_TTL_SECONDS',
  Math.max(300, MQTT_AUTH_CACHE_TTL_SECONDS),
);
const MQTT_AUTH_DENY_CACHE_TTL_SECONDS = readPositiveIntEnv('MQTT_AUTH_DENY_CACHE_TTL_SECONDS', 5);
const MQTT_AUTH_CACHE_MAX_ENTRIES = readPositiveIntEnv('MQTT_AUTH_CACHE_MAX_ENTRIES', 5000);
const MQTT_AUTH_LOADER_TIMEOUT_MS = readPositiveIntEnv('MQTT_AUTH_LOADER_TIMEOUT_MS', 100);
const MQTT_AUTH_USER_LOADER_TIMEOUT_MS = readPositiveIntEnv(
  'MQTT_AUTH_USER_LOADER_TIMEOUT_MS',
  Math.max(500, MQTT_AUTH_LOADER_TIMEOUT_MS),
);
const MQTT_AUTH_COLD_START_TIMEOUT_MS = readPositiveIntEnv(
  'MQTT_AUTH_COLD_START_TIMEOUT_MS',
  Math.max(500, MQTT_AUTH_LOADER_TIMEOUT_MS),
);
const MQTT_AUTH_USER_COLD_START_TIMEOUT_MS = readPositiveIntEnv(
  'MQTT_AUTH_USER_COLD_START_TIMEOUT_MS',
  Math.max(MQTT_AUTH_COLD_START_TIMEOUT_MS, MQTT_AUTH_USER_LOADER_TIMEOUT_MS),
);
const MQTT_AUTH_COLD_START_WINDOW_SECONDS = readPositiveIntEnv('MQTT_AUTH_COLD_START_WINDOW_SECONDS', 30);
const MQTT_AUTH_CACHE_LOG_HITS = /^(1|true|yes)$/i.test(process.env.MQTT_AUTH_CACHE_LOG_HITS ?? 'false');
const MQTT_AUTH_SHARED_CACHE_ENABLED = !/^(0|false|no)$/i.test(process.env.MQTT_AUTH_SHARED_CACHE_ENABLED ?? 'true');
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

function logCacheEvent(event: string, meta: Record<string, unknown>): void {
  if (!MQTT_AUTH_CACHE_LOG_HITS) {
    return;
  }

  authCacheLogger.debug(event, meta);
}

function applyTtlJitter(ttlSeconds: number): number {
  const normalizedTtlSeconds = Math.max(1, ttlSeconds);
  const jitterMultiplier = 1 - MQTT_AUTH_CACHE_JITTER_RATIO + (Math.random() * MQTT_AUTH_CACHE_JITTER_RATIO * 2);
  return Math.max(1, Math.round(normalizedTtlSeconds * jitterMultiplier));
}

function buildCacheEntry<T>(ttlSeconds: number, value: T): CacheEntry<T> {
  return {
    expiresAt: Date.now() + applyTtlJitter(ttlSeconds) * 1000,
    value,
  };
}

function isColdStartWindow(): boolean {
  return process.uptime() < MQTT_AUTH_COLD_START_WINDOW_SECONDS;
}

function getCurrentAuthLoaderTimeoutMs(label: 'user' | 'superuser' | 'acl'): number {
  if (label === 'user') {
    return isColdStartWindow()
      ? Math.max(MQTT_AUTH_USER_LOADER_TIMEOUT_MS, MQTT_AUTH_USER_COLD_START_TIMEOUT_MS)
      : MQTT_AUTH_USER_LOADER_TIMEOUT_MS;
  }

  return isColdStartWindow()
    ? Math.max(MQTT_AUTH_LOADER_TIMEOUT_MS, MQTT_AUTH_COLD_START_TIMEOUT_MS)
    : MQTT_AUTH_LOADER_TIMEOUT_MS;
}

async function executeWithColdStartGrace<T>(
  label: 'user' | 'superuser' | 'acl',
  username: string,
  execute: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  const timeoutMs = getCurrentAuthLoaderTimeoutMs(label);

  try {
    return await execute(timeoutMs);
  } catch (error) {
    if (!isCacheLoaderTimeoutError(error) || !isColdStartWindow()) {
      throw error;
    }

    authCacheLogger.warn('MQTT auth loader timed out during cold start, retrying once', {
      username,
      label,
      timeoutMs,
      uptimeSeconds: Number(process.uptime().toFixed(1)),
    });

    await delay(50);
    const retryTimeoutMs = label === 'user'
      ? Math.max(timeoutMs, MQTT_AUTH_USER_COLD_START_TIMEOUT_MS)
      : Math.max(timeoutMs, MQTT_AUTH_COLD_START_TIMEOUT_MS);

    return execute(retryTimeoutMs);
  }
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
  if (!MQTT_AUTH_SHARED_LOCK_ENABLED || isColdStartWindow()) {
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
  if (!MQTT_AUTH_SHARED_LOCK_ENABLED || isColdStartWindow() || MQTT_AUTH_SHARED_LOCK_WAIT_TIMEOUT_MS <= 0) {
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
  private readonly staleWarnedAt = new Map<string, number>();
  private static readonly STALE_WARN_INTERVAL_MS = 30_000;

  constructor(private readonly maxEntries: number) {}

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.staleWarnedAt.clear();
  }

  set(key: string, entry: CacheEntry<T>): void {
    touchLruEntry(this.entries, key, entry);
    evictLeastRecentlyUsed(this.entries, this.maxEntries);
  }

  async getOrLoad(
    key: string,
    loader: () => Promise<CacheLoadResult<T>>,
    sharedCache?: {
      adapter: SharedCacheAdapter<T>;
      kind: SharedCacheKind;
      scopeKey: string;
    },
    timeoutMs = MQTT_AUTH_LOADER_TIMEOUT_MS,
  ): Promise<T> {
    const now = Date.now();
    const cached = this.entries.get(key);

    if (cached && cached.expiresAt > now) {
      logCacheEvent('MQTT auth cache local hit', { cacheKey: key });
      touchLruEntry(this.entries, key, cached);
      return cached.value;
    }

    // Keep stale entry for fallback if the loader fails (DB outage).
    // It is only removed after a successful load replaces it.
    const staleValue = cached?.value ?? null;

    const pending = this.inFlight.get(key);
    if (pending) {
      logCacheEvent('MQTT auth cache in-flight hit', { cacheKey: key });
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
          logCacheEvent('MQTT auth cache shared hit', {
            cacheKey: key,
            kind: sharedCache.kind,
          });
          return resolveValue(sharedEntry);
        }

        logCacheEvent('MQTT auth cache shared miss', {
          cacheKey: key,
          kind: sharedCache.kind,
        });
      }

      let distributedLock: DistributedLoadLock | null = null;
      if (sharedCache) {
        distributedLock = await tryAcquireDistributedLoadLock(sharedCache.kind, sharedCache.scopeKey);
        logCacheEvent(
          distributedLock ? 'MQTT auth cache distributed lock acquired' : 'MQTT auth cache distributed lock contended',
          {
            cacheKey: key,
            kind: sharedCache.kind,
          },
        );

        if (!distributedLock) {
          const sharedEntry = await waitForSharedCacheFill(sharedCache.kind, sharedCache.scopeKey, sharedCache.adapter);
          if (sharedEntry) {
            logCacheEvent('MQTT auth cache shared fill observed', {
              cacheKey: key,
              kind: sharedCache.kind,
            });
            return resolveValue(sharedEntry);
          }

          logCacheEvent('MQTT auth cache shared fill wait expired', {
            cacheKey: key,
            kind: sharedCache.kind,
          });
        }
      }

      const loadPromise = loader();
      logCacheEvent('MQTT auth cache loader invoked', {
        cacheKey: key,
        kind: sharedCache?.kind,
      });

      return withTimeout(loadPromise, timeoutMs)
        .then(({ ttlSeconds, value }) => {
          const entry = buildCacheEntry(ttlSeconds, value);

          logCacheEvent('MQTT auth cache loader filled', {
            cacheKey: key,
            kind: sharedCache?.kind,
            ttlSeconds,
          });

          if (sharedCache) {
            void writeSharedCacheEntry(sharedCache.kind, sharedCache.scopeKey, entry, sharedCache.adapter);
          }

          // Loader succeeded — remove any stale entry and store fresh one
          if (cached) {
            this.entries.delete(key);
          }
          this.staleWarnedAt.delete(key);
          return resolveValue(entry);
        })
        .catch((err) => {
          // Loader failed (DB timeout/down) — return stale cached value if available
          if (staleValue !== null) {
            const now = Date.now();
            const lastWarned = this.staleWarnedAt.get(key) ?? 0;
            if (now - lastWarned >= InFlightTtlCache.STALE_WARN_INTERVAL_MS) {
              this.staleWarnedAt.set(key, now);
              authCacheLogger.warn('MQTT auth loader failed, serving stale cached value', {
                cacheKey: key,
                error: err instanceof Error ? err.message : String(err),
              });
            }
            return staleValue;
          }
          throw err;
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

export function getUserAllowCacheTtlSeconds(): number {
  return MQTT_AUTH_USER_CACHE_TTL_SECONDS;
}

export function getDenyCacheTtlSeconds(): number {
  return MQTT_AUTH_DENY_CACHE_TTL_SECONDS;
}

export function getAuthLoaderTimeoutMs(label: 'user' | 'superuser' | 'acl' = 'superuser'): number {
  return getCurrentAuthLoaderTimeoutMs(label);
}

export async function seedMqttUserAuthDecision(
  username: string,
  password: string,
  decision: CachedMqttUserAuthDecision,
  ttlSeconds = getUserAllowCacheTtlSeconds(),
): Promise<void> {
  const passwordKey = buildPasswordKey(username, password);
  const cacheKey = `user:${passwordKey}`;
  const entry = buildCacheEntry(ttlSeconds, decision);
  mqttUserAuthCache.set(cacheKey, entry);
  await writeSharedCacheEntry('user', passwordKey, entry, userAuthCacheAdapter);
}

export async function seedMqttSuperuserDecision(
  username: string,
  decision: CachedMqttSuperuserDecision,
  ttlSeconds = getAllowCacheTtlSeconds(),
): Promise<void> {
  const usernameKey = buildUsernameKey(username);
  const cacheKey = `superuser:${username}`;
  const entry = buildCacheEntry(ttlSeconds, decision);
  mqttSuperuserCache.set(cacheKey, entry);
  await writeSharedCacheEntry('superuser', usernameKey, entry, superuserCacheAdapter);
}

export async function seedMqttAclRules(
  username: string,
  result: CachedMqttAclRulesResult,
  ttlSeconds = getAllowCacheTtlSeconds(),
): Promise<void> {
  const usernameKey = buildUsernameKey(username);
  const cacheKey = `acl:${username}`;
  const entry = buildCacheEntry(ttlSeconds, result);
  mqttAclRulesCache.set(cacheKey, entry);
  await writeSharedCacheEntry('acl', usernameKey, entry, aclRulesCacheAdapter);
}

export async function getCachedMqttUserAuthDecision(
  username: string,
  password: string,
  loader: () => Promise<CacheLoadResult<CachedMqttUserAuthDecision>>,
): Promise<CachedMqttUserAuthDecision> {
  const passwordKey = buildPasswordKey(username, password);
  try {
    return await executeWithColdStartGrace('user', username, (timeoutMs) =>
      mqttUserAuthCache.getOrLoad(`user:${passwordKey}`, loader, {
        adapter: userAuthCacheAdapter,
        kind: 'user',
        scopeKey: passwordKey,
      }, timeoutMs)
    );
  } catch (error) {
    if (isCacheLoaderTimeoutError(error)) {
      authCacheLogger.warn('MQTT user auth loader timed out, denying request', {
        timeoutMs: getCurrentAuthLoaderTimeoutMs('user'),
        username,
        coldStart: isColdStartWindow(),
      });
      return { error: isColdStartWindow() ? 'cold-start-timeout' : 'Authentication backend timeout', isSuperuser: false, result: 'deny' };
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
    return await executeWithColdStartGrace('superuser', username, (timeoutMs) =>
      mqttSuperuserCache.getOrLoad(`superuser:${username}`, loader, {
        adapter: superuserCacheAdapter,
        kind: 'superuser',
        scopeKey: usernameKey,
      }, timeoutMs)
    );
  } catch (error) {
    if (isCacheLoaderTimeoutError(error)) {
      authCacheLogger.warn('MQTT superuser loader timed out, denying request', {
        timeoutMs: getCurrentAuthLoaderTimeoutMs('superuser'),
        username,
        coldStart: isColdStartWindow(),
      });
      return { error: isColdStartWindow() ? 'cold-start-timeout' : 'Authorization backend timeout', isSuperuser: false, result: 'deny' };
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
    return await executeWithColdStartGrace('acl', username, (timeoutMs) =>
      mqttAclRulesCache.getOrLoad(`acl:${username}`, loader, {
        adapter: aclRulesCacheAdapter,
        kind: 'acl',
        scopeKey: usernameKey,
      }, timeoutMs)
    );
  } catch (error) {
    if (isCacheLoaderTimeoutError(error)) {
      authCacheLogger.warn('MQTT ACL loader timed out, denying request', {
        timeoutMs: getCurrentAuthLoaderTimeoutMs('acl'),
        username,
        coldStart: isColdStartWindow(),
      });
      return {
        error: isColdStartWindow() ? 'cold-start-timeout' : 'ACL backend timeout',
        rules: [],
      };
    }

    throw error;
  }
}