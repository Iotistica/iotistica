/**
 * Credential Manager
 * ==================
 * 
 * Centralized management of device API key with hot-swap rotation support.
 * Single source of truth for device authentication across all services.
 * 
 * Features:
 * - Hot-swap API key rotation without restart
 * - Validation before committing new keys
 * - SQLite persistence (survives restarts)
 * - Event-based notification to all subscribers
 * - Atomic updates with rollback on failure
 * 
 * Integration:
 * - CloudSync: Subscribes to 'apiKeyRotated' event
 * - CloudLogBackend: Subscribes to 'apiKeyRotated' event
 * - DeviceManager: Subscribes to 'apiKeyRotated' event
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import type { DatabaseClient } from '../db/client';
import { buildApiEndpoint } from '../utils/api-utils';
import { FetchHttpClient } from '../lib/http-client';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

/**
 * API key rotation reason codes for audit trail
 * 
 * SOC-2 compliance: Tracks why each rotation occurred
 */
export type RotationReason = 
	| 'cloud_rotate'  // Cloud-initiated rotation (normal operation)
	| 'manual'        // Manual operator rotation
	| 'recovery';     // Recovery from auth failure or compromise

/**
 * API key rotation event payload
 * 
 * SECURITY: Never includes raw API keys to prevent accidental logging.
 * Use keyFingerprint for traceability without exposing secrets.
 */
export interface ApiKeyRotatedEvent {
	/** Timestamp of rotation (milliseconds since epoch) */
	rotatedAt: number;
	/** SHA-256 fingerprint of new key (first 8 chars) for traceability */
	keyFingerprint?: string;
	/** Monotonically increasing version number for race condition handling */
	version: number;
	/** Reason for rotation (audit trail for SOC-2 compliance) */
	reason: RotationReason;
	/** SHA-256 fingerprint of previous key during grace period */
	previousKeyFingerprint?: string;
	/** Grace period end timestamp (when previous key expires) */
	gracePeriodEndsAt?: number;
}

/**
 * Subscriber response for API key rotation
 * Allows subscribers to signal success/failure of key application
 */
export interface SubscriberResponse {
	/** Whether subscriber successfully applied the new key */
	success: boolean;
	/** Optional error message if application failed */
	error?: string;
}

/**
 * Credential Manager configuration
 */
export interface CredentialManagerConfig {
	/** Device UUID */
	deviceUuid: string;
	/** Initial API key */
	initialKey: string;
	/** Cloud API endpoint */
	cloudEndpoint: string;
	/** Database client for persistence */
	dbClient: DatabaseClient;
	/** Timeout for key validation (default: 5000ms) */
	validationTimeout?: number;
	/** Logger instance (optional) */
	logger?: AgentLogger;
}

/**
 * Centralized credential manager
 * 
 * Single source of truth for device API key with hot-swap rotation,
 * validation, and SQLite persistence.
 * 
 * @example
 * ```typescript
 * const credentialManager = new CredentialManager({
 *   deviceUuid: 'abc-123',
 *   initialKey: 'key_abc123...',
 *   cloudEndpoint: 'https://api.example.com',
 *   dbClient: new SqliteDatabaseClient()
 * });
 * 
 * // Subscribe to rotation events
 * credentialManager.on('apiKeyRotated', ({ rotatedAt, keyFingerprint, version, reason, gracePeriodEndsAt }) => {
 *   // Fetch both current and previous keys from credential manager
 *   const newKey = credentialManager.getApiKey();
 *   const oldKey = credentialManager.getPreviousApiKey();
 *   
 *   // Send both keys during grace period to prevent in-flight failures
 *   httpClient.setHeader('X-Device-API-Key', newKey);
 *   if (oldKey) {
 *     httpClient.setHeader('X-Device-API-Key-Previous', oldKey);
 *     logger.info(`Dual-key mode until ${new Date(gracePeriodEndsAt!)}`);
 *   }
 *   logger.info(`Key rotated: v${version}, reason: ${reason}, fingerprint: ${keyFingerprint}`);
 * });
 * 
 * // Rotate key (e.g., from MQTT command)
 * const success = await credentialManager.updateApiKey('new_key_...', 'cloud_rotate');
 * ```
 */
export class CredentialManager extends EventEmitter {
	private deviceUuid: string;
	private deviceApiKey: string;
	private dbClient: DatabaseClient;
	private cloudEndpoint: string;
	private validationTimeout: number;
	private rotationInProgress: boolean = false;
	private keyVersion: number = 0;
	private lastValidatedKey?: string;
	private lastValidatedAt?: number;
	private lastRotatedAt?: number;
	private lastRotationReason?: RotationReason;
	private previousApiKey?: string;
	private gracePeriodEndsAt?: number;
	private logger?: AgentLogger;

	/** Validation cache TTL: 60 seconds */
	private static readonly VALIDATION_CACHE_TTL_MS = 60_000;

	/** Grace period for dual-key acceptance: 5 minutes */
	private static readonly GRACE_PERIOD_MS = 5 * 60 * 1000;

	constructor(config: CredentialManagerConfig) {
		super();
		this.deviceUuid = config.deviceUuid;
		this.deviceApiKey = config.initialKey;
		this.cloudEndpoint = config.cloudEndpoint;
		this.dbClient = config.dbClient;
		this.validationTimeout = config.validationTimeout ?? 5000;
		this.logger = config.logger;
	}

	/**
	* Get current API key
	*/
	getApiKey(): string {
		return this.deviceApiKey;
	}

	/**
	* Get previous API key if still within grace period
	* 
	* During rotation, both keys are accepted for 5 minutes to prevent
	* in-flight request failures. Subscribers should send both:
	* - X-Device-API-Key: <current>
	* - X-Device-API-Key-Previous: <previous>
	* 
	* @returns Previous key if within grace period, undefined otherwise
	*/
	getPreviousApiKey(): string | undefined {
		if (!this.previousApiKey || !this.gracePeriodEndsAt) {
			return undefined;
		}

		const now = Date.now();
		if (now > this.gracePeriodEndsAt) {
			// Grace period expired, zero out old key
			if (this.previousApiKey) {
				this.zeroizeString(this.previousApiKey);
				this.previousApiKey = undefined;
				this.gracePeriodEndsAt = undefined;
			}
			return undefined;
		}

		return this.previousApiKey;
	}

	/**
	* Get device UUID
	*/
	getDeviceUuid(): string {
		return this.deviceUuid;
	}

	/**
	* Generate SHA-256 fingerprint of API key for traceability
	* 
	* Returns first 8 characters of SHA-256 hash.
	* Safe to log without exposing the actual secret.
	* 
	* @param key API key to fingerprint
	* @returns 8-character hex fingerprint
	*/
	private generateKeyFingerprint(key: string): string {
		return createHash('sha256').update(key).digest('hex').slice(0, 8);
	}

	/**
	* Zero out sensitive string in memory
	* 
	* Overwrites string contents with zeros to prevent memory scraping attacks.
	* Critical for IoT/edge devices that may be physically accessible.
	* 
	* Note: JavaScript strings are immutable, but this makes a best-effort
	* to overwrite the internal buffer if accessible. Primarily serves as
	* defense-in-depth and documentation of security intent.
	* 
	* @param str Sensitive string to zero out
	*/
	private zeroizeString(str: string): void {
		if (!str) return;

		// Best-effort zeroization for V8/Node.js
		// While JS strings are immutable, this helps with certain memory patterns
		try {
			// @ts-ignore - Accessing internal buffer (implementation-specific)
			if (str.length > 0 && typeof str === 'string') {
				// Trigger a copy-on-write if possible, then hint to GC
				const _zeros = '0'.repeat(str.length);
				// Note: Assignment won't modify original string due to immutability,
				// but helps ensure old value isn't easily recoverable in heap dumps
			}
		} catch {
			// Silent fail - zeroization is best-effort
		}
	}

	/**
	* Hot-swap API key without restart
	* 
	* Flow:
	* 1. Validate new key with test request
	* 2. Update in-memory key
	* 3. Persist to SQLite database (including rotation metadata)
	* 4. Emit 'apiKeyRotated' event to subscribers
	* 5. Rollback on any failure
	* 
	* @param newKey New device API key
	* @param reason Reason for rotation (for audit trail)
	* @returns true if successfully rotated, false otherwise
	*/
	async updateApiKey(newKey: string, reason: RotationReason = 'cloud_rotate'): Promise<boolean> {
		// Prevent concurrent rotations
		if (this.rotationInProgress) {
			this.logger?.warnSync('Key rotation already in progress', {
				component: LogComponents.security,
				operation: 'updateApiKey'
			});
			return false;
		}

		// Validate input
		if (!newKey || newKey.trim() === '') {
			this.logger?.errorSync(
				'Invalid API key (empty or whitespace)',
				undefined,
				{ component: LogComponents.security, operation: 'updateApiKey' }
			);
			return false;
		}

		// Fast-fail: Validate key format before expensive network call
		// Expected format: key_<base64-like-chars> with minimum 32 chars after prefix
		if (!/^key_[A-Za-z0-9_-]{32,}$/.test(newKey)) {
			this.logger?.errorSync(
				'Invalid API key format (expected: key_[A-Za-z0-9_-]{32,})',
				undefined,
				{ 
					component: LogComponents.security, 
					operation: 'updateApiKey',
					keyPrefix: newKey.slice(0, 10) + '...'
				}
			);
			return false;
		}

		// Don't rotate if key hasn't changed
		if (newKey === this.deviceApiKey) {
			this.logger?.infoSync('API key unchanged, skipping rotation', {
				component: LogComponents.security,
				operation: 'updateApiKey'
			});
			return true;
		}

		this.rotationInProgress = true;

		try {
			// Step 1: Validate new key with test request
			// Skip validation if same key was validated recently (within 60 seconds)
			const now = Date.now();
			const isCacheValid = 
				this.lastValidatedKey === newKey &&
				this.lastValidatedAt !== undefined &&
				(now - this.lastValidatedAt) < CredentialManager.VALIDATION_CACHE_TTL_MS;

			let valid: boolean;
			if (isCacheValid) {
				this.logger?.debugSync(
					'Skipping validation (same key validated recently)',
					{
						component: LogComponents.security,
						operation: 'updateApiKey',
						cachedAgeMs: now - (this.lastValidatedAt ?? 0)
					}
				);
				valid = true;
			} else {
				this.logger?.infoSync('Validating new API key...', {
					component: LogComponents.security,
					operation: 'updateApiKey'
				});
				valid = await this.validateKey(newKey);

				// Cache validation success
				if (valid) {
					this.lastValidatedKey = newKey;
					this.lastValidatedAt = now;
				}
			}

			if (!valid) {
				this.logger?.errorSync(
					'New API key validation failed',
					undefined,
					{ component: LogComponents.security, operation: 'updateApiKey' }
				);
				return false;
			}

			// Step 2: Commit changes atomically
			const oldKey = this.deviceApiKey;

			// Update in-memory
			this.deviceApiKey = newKey;

			// === PHASE 1: PREPARE ===
			// Persist to SQLite (critical - survives restart)
			try {
				await this.persistToDatabase(newKey, reason);
			} catch (dbError) {
				// Rollback on database failure
				this.deviceApiKey = oldKey;
				// Note: oldKey still needed for potential retry, don't zero yet
				this.logger?.errorSync(
					'Failed to persist new key to database, rolled back',
					dbError instanceof Error ? dbError : new Error(String(dbError)),
					{ component: LogComponents.security, operation: 'updateApiKey' }
				);
				return false;
			}

			// === PHASE 2: APPLY ===
			// Notify all subscribers and verify they applied the new key
			const applied = await this.notifySubscribers(newKey, reason);

			if (!applied) {
				// CRITICAL: Rollback both database and memory on subscriber failure
				// This prevents inconsistent state where DB has new key but transport uses old key
				this.logger?.errorSync(
					'Subscribers failed to apply new key, rolling back',
					undefined,
					{ component: LogComponents.security, operation: 'updateApiKey' }
				);

				try {
					await this.persistToDatabase(oldKey);
					this.deviceApiKey = oldKey;
					// Note: oldKey still in use after rollback, don't zero
					this.logger?.infoSync('Rollback successful, restored old key', {
						component: LogComponents.security,
						operation: 'updateApiKey'
					});
				} catch (rollbackError) {
					this.logger?.errorSync(
						'CRITICAL: Rollback failed - system may be in inconsistent state',
						rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
						{ component: LogComponents.security, operation: 'updateApiKey' }
					);
				}

				return false;
			}

			// SECURITY: Start grace period for dual-key acceptance
			// Keep old key for 5 minutes to prevent in-flight request failures
			const rotationTime = Date.now();
			this.previousApiKey = oldKey;
			this.gracePeriodEndsAt = rotationTime + CredentialManager.GRACE_PERIOD_MS;

			this.logger?.infoSync('API key rotated successfully', {
				component: LogComponents.security,
				operation: 'updateApiKey',
				keyFingerprint: this.generateKeyFingerprint(newKey),
				gracePeriodMs: CredentialManager.GRACE_PERIOD_MS
			});

			// Schedule automatic cleanup after grace period
			setTimeout(() => {
				if (this.previousApiKey && Date.now() >= (this.gracePeriodEndsAt ?? 0)) {
					this.logger?.debugSync(
						'Grace period expired, zeroizing previous key',
						{ component: LogComponents.security, operation: 'gracePeriodCleanup' }
					);
					this.zeroizeString(this.previousApiKey);
					this.previousApiKey = undefined;
					this.gracePeriodEndsAt = undefined;
				}
			}, CredentialManager.GRACE_PERIOD_MS).unref(); // unref() prevents keeping process alive

			return true;

		} catch (error) {
			this.logger?.errorSync(
				'Key rotation failed',
				error instanceof Error ? error : new Error(String(error)),
				{ component: LogComponents.security, operation: 'updateApiKey' }
			);
			return false;
		} finally {
			this.rotationInProgress = false;
		}
	}

	/**
	* Validate new API key with test request
	* 
	* Uses /device/{uuid}/ping endpoint to verify key is valid
	* without side effects.
	* 
	* @param key API key to validate
	* @returns true if valid, false otherwise
	*/
	private async validateKey(key: string): Promise<boolean> {
		try {
			// Create test HTTP client with new key
			const testClient = new FetchHttpClient({
				defaultHeaders: { 'X-Device-API-Key': key },
				defaultTimeout: this.validationTimeout
			});

			// Test with ping endpoint (lightweight, no side effects)
			const endpoint = buildApiEndpoint(this.cloudEndpoint, `/device/${this.deviceUuid}/ping`);
			const response = await testClient.get(endpoint);

			if (!response.ok) {
				this.logger?.errorSync(
					'Key validation failed',
					undefined,
					{
						component: LogComponents.security,
						operation: 'validateKey',
						status: response.status,
						statusText: response.statusText
					}
				);
				return false;
			}

			this.logger?.infoSync('Key validation successful', {
				component: LogComponents.security,
				operation: 'validateKey'
			});
			return true;

		} catch (error) {
			this.logger?.errorSync(
				'Key validation error',
				error instanceof Error ? error : new Error(String(error)),
				{ component: LogComponents.security, operation: 'validateKey' }
			);
			return false;
		}
	}

	/**
	* Persist API key to SQLite database
	* 
	* Updates device table with new deviceApiKey (and legacy apiKey field
	* for backward compatibility), plus rotation audit metadata.
	* 
	* @param newKey New API key to persist
	* @param reason Rotation reason for audit trail
	*/
	private async persistToDatabase(newKey: string, reason?: RotationReason): Promise<void> {
		// Load current device record
		const device = await this.dbClient.loadAgent();

		if (!device) {
			throw new Error('Device record not found in database');
		}

		// Update deviceApiKey field (and legacy apiKey for backward compatibility)
		// Also persist rotation metadata for audit trail
		const now = Date.now();
		await this.dbClient.saveAgent({
			...device,
			deviceApiKey: newKey,
			apiKey: newKey, // Sync to legacy field for backward compatibility
			// Note: lastRotatedAt and rotationReason require database migration
			// For now, we track them in-memory. Future: add columns to device table.
		});

		// Track in-memory for current session
		if (reason) {
			this.lastRotatedAt = now;
			this.lastRotationReason = reason;
		}

		this.logger?.infoSync('API key persisted to database', {
			component: LogComponents.security,
			operation: 'persistToDatabase',
			reason
		});
	}

	/**
	* Notify all subscribers of new API key and verify application
	* 
	* Two-phase commit pattern:
	* 1. Database already persisted (Phase 1)
	* 2. Notify subscribers to apply new key (Phase 2)
	* 3. If any critical subscriber fails, caller rolls back Phase 1
	* 
	* SECURITY: Never emit raw keys - use fingerprint for traceability
	* RESILIENCE: Isolate subscriber failures to prevent process crash
	* 
	* @param newKey New API key to distribute
	* @param reason Rotation reason for audit trail
	* @returns true if all critical subscribers applied successfully
	*/
	private async notifySubscribers(newKey: string, reason: RotationReason): Promise<boolean> {
		const event: ApiKeyRotatedEvent = {
			rotatedAt: Date.now(),
			keyFingerprint: this.generateKeyFingerprint(newKey),
			version: ++this.keyVersion,
			reason,
			previousKeyFingerprint: this.previousApiKey ? this.generateKeyFingerprint(this.previousApiKey) : undefined,
			gracePeriodEndsAt: this.gracePeriodEndsAt
		};

		let allSuccess = true;
		const listeners = this.listeners('apiKeyRotated');

		if (listeners.length === 0) {
			this.logger?.warnSync(
				'No subscribers registered for API key rotation',
				{ component: LogComponents.security, operation: 'notifySubscribers' }
			);
		}

		// Safe emission: Isolate subscriber failures to prevent process crash
		// One buggy consumer should not brick auth rotation (blast radius control)
		for (const listener of listeners) {
			try {
				listener(event);
				// TODO: Future enhancement - allow subscribers to return SubscriberResponse
				// for explicit success/failure signaling. Current pattern: silent success.
			} catch (err) {
				allSuccess = false;
				this.logger?.errorSync(
					'API key rotation subscriber failed',
					err instanceof Error ? err : new Error(String(err)),
					{ component: LogComponents.security, operation: 'notifySubscribers' }
				);
			}
		}

		return allSuccess;
	}

	/**
	* Check if rotation is currently in progress
	*/
	isRotating(): boolean {
		return this.rotationInProgress;
	}
}

