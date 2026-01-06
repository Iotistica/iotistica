/**
 * CRYPTO UTILITIES - UUID Generation and API Key Generation
 * ==========================================================
 * 
 * Provides cryptographic utilities for device provisioning and security.
 */

import * as crypto from 'crypto';

/**
 * UUID Generator Interface for dependency injection
 */
export interface UuidGenerator {
	generate(): string;
}

/**
 * Default UUID generator using crypto.randomUUID (Node 14.17+)
 * Falls back to manual generation for older versions
 */
export class DefaultUuidGenerator implements UuidGenerator {
	generate(): string {
		// Use crypto.randomUUID if available (Node 14.17+)
		if (crypto.randomUUID) {
			return crypto.randomUUID();
		}
		// Fallback UUID v4 generator
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
			const r = Math.random() * 16 | 0;
			const v = c === 'x' ? r : (r & 0x3 | 0x8);
			return v.toString(16);
		});
	}
}

/**
 * API Key Format v1: 64 hex chars
 * API Key Format v2: v2_{kid}_{secret} where kid=8 hex, secret=64 hex
 */
export interface ParsedAPIKey {
	version: 'v1' | 'v2';
	kid?: string;      // Key ID (only for v2)
	secret: string;    // Actual secret key
}

/**
 * Generate cryptographically secure API key
 * @param version - Key format version ('v1' or 'v2'), defaults to 'v1'
 * @returns API key in specified format
 */
export function generateAPIKey(version: 'v1' | 'v2' = 'v1'): string {
	if (version === 'v2') {
		const kid = crypto.randomBytes(4).toString('hex'); // 8 hex chars
		const secret = crypto.randomBytes(32).toString('hex'); // 64 hex chars
		return `v2_${kid}_${secret}`;
	}
	// v1 format: 64 hex chars
	return crypto.randomBytes(32).toString('hex');
}

/**
 * Parse API key into components (supports v1 and v2 formats)
 * @param key - API key in v1 or v2 format
 * @returns Parsed key components
 */
export function parseAPIKey(key: string): ParsedAPIKey {
	if (key.startsWith('v2_')) {
		const parts = key.split('_');
		if (parts.length !== 3) {
			throw new Error('Invalid v2 API key format');
		}
		return {
			version: 'v2',
			kid: parts[1],
			secret: parts[2]
		};
	}
	// v1 format (legacy)
	return {
		version: 'v1',
		secret: key
	};
}

/**
 * Get API key fingerprint for safe logging (SHA-256 hash prefix)
 * @param key - API key to fingerprint
 * @returns First 8 chars of SHA-256 hash
 */
export function getAPIKeyFingerprint(key: string): string {
	const hash = crypto.createHash('sha256').update(key).digest('hex');
	return hash.substring(0, 8);
}

/**
 * Compute proof-of-possession for key exchange
 * Uses HMAC-SHA256(deviceApiKey.secret, challenge + ':' + uuid)
 * @param challenge - Server-provided nonce
 * @param deviceApiKey - Device API key (v1 or v2 format)
 * @param uuid - Device UUID
 * @returns HMAC-SHA256 proof in hex format
 */
export function computeKeyExchangeProof(challenge: string, deviceApiKey: string, uuid: string): string {
	const parsed = parseAPIKey(deviceApiKey);
	const message = `${challenge}:${uuid}`;
	return crypto.createHmac('sha256', parsed.secret).update(message).digest('hex');
}
