/**
 * UUID Base64 URL-safe codec for MQTT topic compression.
 *
 * Encodes standard UUIDs (36 chars) into Base64 URL-safe strings (22 chars)
 * to reduce MQTT topic size. This is NOT security — it is reversible encoding
 * for size reduction and obfuscation only.
 *
 * Rules:
 *  - Replace '+' with '-', '/' with '_' (URL-safe)
 *  - Remove '=' padding
 */

import { Buffer } from 'buffer';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENCODED_REGEX = /^[A-Za-z0-9_-]{22}$/;
// 12-char hex tenant IDs (6 bytes) encode to exactly 8 base64url chars (no padding)
const HEX_ID_REGEX = /^[0-9a-f]{12}$/i;
const ENCODED_HEX_REGEX = /^[A-Za-z0-9_-]{8}$/;

// LRU-style caches to avoid repeated encode/decode on hot paths
const encodeCache = new Map<string, string>();
const decodeCache = new Map<string, string>();
const MAX_CACHE_SIZE = 1024;

function evictOldest(cache: Map<string, string>): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) {
      cache.delete(firstKey);
    }
  }
}

/**
 * Encode a standard UUID string to a 22-char Base64 URL-safe string.
 */
export function encodeUuid(uuid: string): string {
  const cached = encodeCache.get(uuid);
  if (cached) return cached;

  if (!UUID_REGEX.test(uuid)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }

  const hex = uuid.replace(/-/g, '');
  const bytes = Buffer.from(hex, 'hex');
  const encoded = bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  evictOldest(encodeCache);
  encodeCache.set(uuid, encoded);

  // Also populate reverse cache
  evictOldest(decodeCache);
  decodeCache.set(encoded, uuid.toLowerCase());

  return encoded;
}

/**
 * Decode a 22-char Base64 URL-safe string back to a standard UUID.
 */
export function decodeUuid(encoded: string): string {
  const cached = decodeCache.get(encoded);
  if (cached) return cached;

  if (!ENCODED_REGEX.test(encoded)) {
    throw new Error(`Invalid encoded UUID: ${encoded}`);
  }

  const base64 = encoded
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=');

  const bytes = Buffer.from(base64, 'base64');

  if (bytes.length !== 16) {
    throw new Error(`Invalid encoded UUID: decoded to ${bytes.length} bytes, expected 16`);
  }

  const hex = bytes.toString('hex');
  const uuid = [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20),
  ].join('-');

  evictOldest(decodeCache);
  decodeCache.set(encoded, uuid);

  return uuid;
}

/**
 * Check if a string looks like a standard UUID (36 chars with dashes).
 */
export function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

/**
 * Check if a string looks like an encoded UUID (22 chars, base64url).
 */
export function isEncodedUuid(value: string): boolean {
  return ENCODED_REGEX.test(value);
}

/**
 * Check if a string is a 12-char hex tenant ID.
 */
export function isHexId(value: string): boolean {
  return HEX_ID_REGEX.test(value);
}

/**
 * Check if a string looks like an 8-char encoded hex ID (base64url).
 */
export function isEncodedHexId(value: string): boolean {
  return ENCODED_HEX_REGEX.test(value);
}

/**
 * Encode a 12-char hex tenant ID to an 8-char Base64 URL-safe string.
 * 6 bytes → 8 base64 chars (divisible by 3, no padding needed).
 */
export function encodeHexId(hex: string): string {
  const cached = encodeCache.get(hex);
  if (cached) return cached;

  if (!HEX_ID_REGEX.test(hex)) {
    throw new Error(`Invalid hex ID: ${hex}`);
  }

  const encoded = Buffer.from(hex, 'hex')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  evictOldest(encodeCache);
  encodeCache.set(hex, encoded);
  evictOldest(decodeCache);
  decodeCache.set(encoded, hex.toLowerCase());

  return encoded;
}

/**
 * Decode an 8-char Base64 URL-safe string back to a 12-char hex tenant ID.
 */
export function decodeHexId(encoded: string): string {
  const cached = decodeCache.get(encoded);
  if (cached) return cached;

  if (!ENCODED_HEX_REGEX.test(encoded)) {
    throw new Error(`Invalid encoded hex ID: ${encoded}`);
  }

  const bytes = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  if (bytes.length !== 6) {
    throw new Error(`Invalid encoded hex ID: decoded to ${bytes.length} bytes, expected 6`);
  }

  const result = bytes.toString('hex');

  evictOldest(decodeCache);
  decodeCache.set(encoded, result);

  return result;
}

/**
 * Encode any recognized topic ID: UUID → 22 chars, 12-char hex → 8 chars.
 * Passes through MQTT wildcards (+, #, *) unchanged.
 */
export function encodeIfUuid(value: string): string {
  if (value === '+' || value === '#' || value === '*') return value;
  if (isUuid(value)) return encodeUuid(value);
  if (isHexId(value)) return encodeHexId(value);
  return value;
}

/** Clear caches (for testing). */
export function clearCodecCaches(): void {
  encodeCache.clear();
  decodeCache.clear();
}
