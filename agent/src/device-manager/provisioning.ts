/**
 * Device provisioning manager for standalone container-manager
 * Implements two-phase authentication inspired by Balena Supervisor
 * 
 * Flow:
 * 1. Generate UUID and deviceApiKey locally
 * 2. Use provisioningApiKey (fleet-level) to register device
 * 3. Exchange provisioningApiKey for deviceApiKey authentication
 * 4. Remove provisioningApiKey (one-time use)
 * 5. Setup VPN tunnel if provided in provisioning response
 * 
 * Refactored for testability with dependency injection:
 * - HttpClient abstraction for API calls (no global fetch stubbing needed)
 * - DatabaseClient abstraction for database operations (no Knex mocking needed)
 */

import type { 
	DeviceInfo, 
	ProvisioningConfig, 
	ProvisionRequest, 
	ProvisionResponse,
	KeyExchangeRequest
} from './types';
import { DeviceModel } from '../db/models/device.model';
import { buildApiEndpoint, getPackageVersion } from '../utils/api-utils';
import * as path from 'path';
import { 
	DefaultUuidGenerator, 
	generateAPIKey, 
	getAPIKeyFingerprint, 
	parseAPIKey,
	computeKeyExchangeProof,
	type UuidGenerator 
} from '../utils/crypto';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { HttpClient, FetchHttpClient } from '../lib/http-client';
import { DatabaseClient, KnexDatabaseClient } from '../db/client';

export class DeviceManager {
	private deviceInfo: DeviceInfo | null = null;
	private logger?: AgentLogger;
	private httpClient: HttpClient;
	private dbClient: DatabaseClient;
	private uuidGenerator: UuidGenerator;

	// Retry configuration for unreliable edge networks
	private readonly PROVISIONING_TIMEOUT_MS = 30000; // 30s per attempt
	private readonly MAX_RETRY_ATTEMPTS = 5; // Total attempts: 1 initial + 5 retries
	private readonly INITIAL_RETRY_DELAY_MS = 1000; // Start at 1s
	private readonly MAX_RETRY_DELAY_MS = 32000; // Cap at 32s

	constructor(
		logger?: AgentLogger,
		httpClient?: HttpClient,
		dbClient?: DatabaseClient,
		uuidGenerator?: UuidGenerator
	) {
		this.logger = logger;
		this.httpClient = httpClient || new FetchHttpClient();
		this.dbClient = dbClient || new KnexDatabaseClient();
		this.uuidGenerator = uuidGenerator || new DefaultUuidGenerator();
	}

	/**
	 * Retry wrapper with exponential backoff and timeout
	 * Handles unreliable edge network connections
	 * 
	 * @param operation - Async operation to retry
	 * @param operationName - Name for logging
	 * @param timeout - Timeout per attempt (default: 30s)
	 * @returns Result of successful operation
	 */
	private async retryWithBackoff<T>(
		operation: () => Promise<T>,
		operationName: string,
		timeout: number = this.PROVISIONING_TIMEOUT_MS
	): Promise<T> {
		let lastError: Error | null = null;
		let delay = this.INITIAL_RETRY_DELAY_MS;

		for (let attempt = 0; attempt <= this.MAX_RETRY_ATTEMPTS; attempt++) {
			try {
				this.logger?.infoSync(`Attempting ${operationName}`, {
					component: LogComponents.deviceManager,
					operation: 'retryWithBackoff',
					attempt: attempt + 1,
					maxAttempts: this.MAX_RETRY_ATTEMPTS + 1,
					timeoutMs: timeout,
				});

				// Execute operation with timeout
				const result = await this.withTimeout(operation(), timeout, operationName);
				
				if (attempt > 0) {
					this.logger?.infoSync(`${operationName} succeeded after retries`, {
						component: LogComponents.deviceManager,
						operation: 'retryWithBackoff',
						attempt: attempt + 1,
					});
				}
				
				return result;
			} catch (error: any) {
				lastError = error instanceof Error ? error : new Error(String(error));
				
				if (attempt < this.MAX_RETRY_ATTEMPTS) {
					this.logger?.warnSync(`${operationName} failed, retrying`, {
						component: LogComponents.deviceManager,
						operation: 'retryWithBackoff',
						attempt: attempt + 1,
						delayMs: delay,
						error: lastError.message,
					});
					
					// Exponential backoff with jitter
					await this.sleep(delay);
					delay = Math.min(delay * 2, this.MAX_RETRY_DELAY_MS);
				} else {
					this.logger?.errorSync(
						`${operationName} failed after ${this.MAX_RETRY_ATTEMPTS + 1} attempts`,
						lastError,
						{
							component: LogComponents.deviceManager,
							operation: 'retryWithBackoff',
						}
					);
				}
			}
		}

		throw lastError || new Error(`${operationName} failed after all retries`);
	}

	/**
	 * Execute operation with timeout
	 * 
	 * @param promise - Promise to execute
	 * @param timeoutMs - Timeout in milliseconds
	 * @param operationName - Name for error messages
	 */
	private async withTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number,
		operationName: string
	): Promise<T> {
		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => {
				reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});

		return Promise.race([promise, timeoutPromise]);
	}

	/**
	 * Sleep for specified milliseconds
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Initialize device manager and load device info from database
	 */
	async initialize(): Promise<void> {
		// Initialize encryption for secure credential storage in persisted location
		// CRITICAL: Use absolute path /app/data (Docker volume) so encryption key persists across rebuilds
		// DO NOT use process.cwd() - it may vary across environments
		console.log('[Provisioning] Initializing encryption with /app/data');
		DeviceModel.initializeEncryption('/app/data');
		console.log('[Provisioning] Encryption initialized, loading device info');

		await this.loadDeviceInfo();

		if (!this.deviceInfo) {
			// Create new device with generated UUID and deviceApiKey
			const newApiKey = generateAPIKey('v2'); // Generate v2 versioned key
			const keyMetadata = parseAPIKey(newApiKey);
			
			this.deviceInfo = {
				uuid: this.uuidGenerator.generate(),
				deviceApiKey: newApiKey,
				provisioned: false,
				provisioningState: 'new',
				agentVersion: process.env.AGENT_VERSION || getPackageVersion(),
			};
			await this.saveDeviceInfo();
			this.logger?.infoSync('New device created with versioned API key', {
				component: LogComponents.deviceManager,
				operation: 'initialize',
				uuid: this.deviceInfo.uuid,
				keyVersion: keyMetadata?.version,
				keyFingerprint: getAPIKeyFingerprint(newApiKey),
				keyId: keyMetadata?.kid,
			});
		} else {
			// Update agent version on every startup (BEFORE logging)
			const currentVersion = process.env.AGENT_VERSION || getPackageVersion();
			if (this.deviceInfo.agentVersion !== currentVersion) {
				const oldVersion = this.deviceInfo.agentVersion;
				this.deviceInfo.agentVersion = currentVersion;
				await this.saveDeviceInfo();
				this.logger?.infoSync('Agent version updated', {
					component: LogComponents.deviceManager,
					operation: 'initialize',
					oldVersion,
					newVersion: currentVersion,
				});
			}
			
			// Log device info with key metadata (safe fingerprint, no secrets)
			const keyMetadata = this.deviceInfo.deviceApiKey 
				? parseAPIKey(this.deviceInfo.deviceApiKey) 
				: null;
			
			this.logger?.infoSync('Device loaded', {
				component: LogComponents.deviceManager,
				operation: 'initialize',
				uuid: this.deviceInfo.uuid,
				deviceId: this.deviceInfo.deviceId,
				provisioned: this.deviceInfo.provisioned,
				provisioningState: this.deviceInfo.provisioningState || 'unknown',
				hasDeviceApiKey: !!this.deviceInfo.deviceApiKey,
				keyVersion: keyMetadata?.version,
				keyFingerprint: this.deviceInfo.deviceApiKey 
					? getAPIKeyFingerprint(this.deviceInfo.deviceApiKey) 
					: undefined,
				hasProvisioningKey: !!this.deviceInfo.provisioningApiKey,
				agentVersion: this.deviceInfo.agentVersion,
			});
		}
	}

	/**
	 * Load device info from database
	 */
	private async loadDeviceInfo(): Promise<void> {
		const record = await this.dbClient.loadDevice();
		if (record) {
			// Debug: log record before parsing
			this.logger?.debugSync('Record loaded from database', {
				component: LogComponents.deviceManager,
				operation: 'loadDeviceInfo',
				hasRecord: !!record,
				hasApiTlsConfig: !!record.apiTlsConfig,
				apiTlsConfigType: typeof record.apiTlsConfig,
				apiTlsConfigLength: record.apiTlsConfig?.length
			});

			this.deviceInfo = {
				uuid: record.uuid,
				deviceId: record.deviceId?.toString(),
				deviceName: record.deviceName || undefined,
				deviceType: record.deviceType || undefined,
				deviceApiKey: record.deviceApiKey || undefined,
				provisioningApiKey: record.provisioningApiKey || undefined,
				apiKey: record.apiKey || undefined, // Legacy field
				apiEndpoint: record.apiEndpoint || undefined,
				registeredAt: record.registeredAt || undefined,
				provisioned: !!record.provisioned,
				provisioningState: (record.provisioningState as any) || (record.provisioned ? 'provisioned' : 'new'),
			applicationId: record.applicationId || undefined,
			macAddress: record.macAddress || undefined,
			osVersion: record.osVersion || undefined,
			agentVersion: record.agentVersion || undefined,

			mqttBrokerConfig: record.mqttBrokerConfig ? JSON.parse(record.mqttBrokerConfig) : undefined,
			apiTlsConfig: record.apiTlsConfig ? JSON.parse(record.apiTlsConfig) : undefined,
		};
		
		// Debug: log parsed deviceInfo
		this.logger?.debugSync('Parsed deviceInfo from database', {
			component: LogComponents.deviceManager,
			operation: 'loadDeviceInfo',
			hasDeviceInfo: !!this.deviceInfo,
			hasApiTlsConfig: !!this.deviceInfo?.apiTlsConfig,
			apiTlsConfigKeys: this.deviceInfo?.apiTlsConfig ? Object.keys(this.deviceInfo.apiTlsConfig) : []
		});
	}
}
	/**
	 * Save device info to database
	 */
	private async saveDeviceInfo(): Promise<void> {
		if (!this.deviceInfo) {
			throw new Error('No device info to save');
		}

		// Ensure backward compatibility: sync deviceApiKey to apiKey field
		if (this.deviceInfo.deviceApiKey && !this.deviceInfo.apiKey) {
			this.deviceInfo.apiKey = this.deviceInfo.deviceApiKey;
		}

		const data = {
			uuid: this.deviceInfo.uuid,
			deviceId: this.deviceInfo.deviceId ? parseInt(this.deviceInfo.deviceId) : null,
			deviceName: this.deviceInfo.deviceName || null,
			deviceType: this.deviceInfo.deviceType || null,
			deviceApiKey: this.deviceInfo.deviceApiKey || null,
			provisioningApiKey: this.deviceInfo.provisioningApiKey || null,
			apiKey: this.deviceInfo.apiKey || null, // Legacy (synced from deviceApiKey)
			apiEndpoint: this.deviceInfo.apiEndpoint || null,
			registeredAt: this.deviceInfo.registeredAt || null,
			provisioned: this.deviceInfo.provisioned,
			provisioningState: this.deviceInfo.provisioningState || 'new',
			applicationId: this.deviceInfo.applicationId || null,
			macAddress: this.deviceInfo.macAddress || null,
			osVersion: this.deviceInfo.osVersion || null,
			agentVersion: this.deviceInfo.agentVersion || null,
			mqttBrokerConfig: this.deviceInfo.mqttBrokerConfig ? JSON.stringify(this.deviceInfo.mqttBrokerConfig) : null,
			apiTlsConfig: this.deviceInfo.apiTlsConfig ? JSON.stringify(this.deviceInfo.apiTlsConfig) : null,
			updatedAt: new Date().toISOString(),
		};
		
		await this.dbClient.saveDevice(data);
	}

	/**
	 * Get current device info
	 */
	getDeviceInfo(): DeviceInfo {
		if (!this.deviceInfo) {
			throw new Error('Device manager not initialized');
		}
		
		// Ensure backward compatibility: populate apiKey from deviceApiKey if not set
		const info = { ...this.deviceInfo };
		if (!info.apiKey && info.deviceApiKey) {
			info.apiKey = info.deviceApiKey;
		}
		
		return info;
	}

	/**
	 * Check if device is provisioned
	 */
	isProvisioned(): boolean {
		return this.deviceInfo?.provisioned === true;
	}

	/**
	 * Create authorization headers for API requests
	 */
	private createAuthHeaders(apiKey: string): Record<string, string> {
		return {
			'Authorization': `Bearer ${apiKey}`,
		};
	}

	/**
	 * Mark device as running in local mode (no cloud provisioning needed)
	 */
	async markAsLocalMode(): Promise<void> {
		if (!this.deviceInfo) {
			throw new Error('Device manager not initialized');
		}

		this.deviceInfo.provisioned = false; // Explicitly mark as NOT cloud-provisioned
		this.deviceInfo.provisioningState = 'new';
		this.deviceInfo.deviceName = this.deviceInfo.deviceName || `device-${this.deviceInfo.uuid.slice(0, 8)}`;
		this.deviceInfo.deviceType = this.deviceInfo.deviceType || 'standalone';
		this.deviceInfo.agentVersion = process.env.AGENT_VERSION || getPackageVersion(); // Update agent version
		
		await this.saveDeviceInfo();

		this.logger?.infoSync('Device configured for local mode', {
			component: LogComponents.deviceManager,
			operation: 'markAsLocalMode',
			uuid: this.deviceInfo.uuid,
			deviceName: this.deviceInfo.deviceName,
			agentVersion: this.deviceInfo.agentVersion,
		});
	}

	/**
	 * Provision device using two-phase authentication
	 * Phase 1: Register device using provisioningApiKey
	 * Phase 2: Exchange keys and remove provisioning key
	 */
	async provision(config: ProvisioningConfig): Promise<DeviceInfo> {
		if (!this.deviceInfo) {
			throw new Error('Device manager not initialized');
		}

		if (!config.provisioningApiKey) {
			throw new Error('provisioningApiKey is required for device provisioning');
		}

		// Ensure device API key exists (generate v2 if missing)
		if (!this.deviceInfo.deviceApiKey) {
			this.deviceInfo.deviceApiKey = generateAPIKey('v2');
			const keyMetadata = parseAPIKey(this.deviceInfo.deviceApiKey);
			this.logger?.infoSync('Generated new API key for provisioning', {
				component: LogComponents.deviceManager,
				operation: 'provision',
				keyVersion: keyMetadata?.version,
				keyId: keyMetadata?.kid,
				keyFingerprint: getAPIKeyFingerprint(this.deviceInfo.deviceApiKey),
			});
		}

			// Update device metadata
		this.deviceInfo.deviceName = config.deviceName || this.deviceInfo.deviceName || `device-${this.deviceInfo.uuid.slice(0, 8)}`;
		this.deviceInfo.deviceType = config.deviceType || this.deviceInfo.deviceType || 'generic';
		this.deviceInfo.apiEndpoint = config.apiEndpoint || this.deviceInfo.apiEndpoint;
		this.deviceInfo.provisioningApiKey = config.provisioningApiKey;
		this.deviceInfo.applicationId = config.applicationId;
		this.deviceInfo.macAddress = config.macAddress;
		this.deviceInfo.osVersion = config.osVersion;
		this.deviceInfo.agentVersion = config.agentVersion;

		// UUID is immutable after cloud registration (prevents device identity hijacking)
		// Only allow UUID override for new/unprovisioned devices
		if (config.uuid && config.uuid !== this.deviceInfo.uuid) {
			const currentState = this.deviceInfo.provisioningState || 'new';
			const isRegistered = currentState !== 'new' && currentState !== 'registering';
			
			if (isRegistered) {
				// Device already registered with cloud - UUID cannot be changed
				this.logger?.errorSync(
					'Attempt to change UUID after cloud registration (rejected)',
					new Error('UUID is immutable after provisioning'),
					{
						component: LogComponents.deviceManager,
						operation: 'provision',
						currentUuid: this.deviceInfo.uuid,
						attemptedUuid: config.uuid,
						provisioningState: currentState,
					}
				);
				throw new Error(
					`UUID cannot be changed after cloud registration. ` +
					`Current UUID: ${this.deviceInfo.uuid}, ` +
					`Attempted UUID: ${config.uuid}. ` +
					`Use factory reset to re-provision with a new UUID.`
				);
			} else {
				// Device not yet registered - UUID change allowed
				this.logger?.warnSync('Changing device UUID before registration', {
					component: LogComponents.deviceManager,
					operation: 'provision',
					oldUuid: this.deviceInfo.uuid,
					newUuid: config.uuid,
					note: 'UUID override allowed only before cloud registration',
				});
				this.deviceInfo.uuid = config.uuid;
			}
		}

		try {
			const currentState = this.deviceInfo.provisioningState || 'new';
			
			// Check if we're resuming from a partial failure
			if (currentState !== 'new' && currentState !== 'provisioned') {
				this.logger?.warnSync('Resuming incomplete provisioning', {
					component: LogComponents.deviceManager,
					operation: 'provision',
					currentState,
					note: 'Previous provisioning attempt failed mid-flight - resuming from last checkpoint',
				});
			}
			
			// Phase 1: Register device with cloud API (idempotent)
			let response: ProvisionResponse | undefined;
			
			if (currentState === 'new' || currentState === 'registering') {
				this.logger?.infoSync('Phase 1: Registering device with provisioning key', {
					component: LogComponents.deviceManager,
					operation: 'provision',
					state: 'registering',
				});
				
				// Mark as registering before API call
				this.deviceInfo.provisioningState = 'registering';
				await this.saveDeviceInfo();
				
				// Capture values for closure (TypeScript can't track through await/closures)
				const apiEndpoint = this.deviceInfo.apiEndpoint || 'http://localhost:3002';
				const uuid = this.deviceInfo.uuid;
				const deviceName = this.deviceInfo.deviceName!; // Guaranteed by line 401
				const deviceType = this.deviceInfo.deviceType!; // Guaranteed by line 402
				const deviceApiKey = this.deviceInfo.deviceApiKey!; // Guaranteed by line 387-396
				const applicationId = this.deviceInfo.applicationId;
				const macAddress = this.deviceInfo.macAddress;
				const osVersion = this.deviceInfo.osVersion;
				const agentVersion = this.deviceInfo.agentVersion;
				const provisioningApiKey = this.deviceInfo.provisioningApiKey!; // Guaranteed by line 381
				
				// Wrap with retry logic for unreliable edge networks
				response = await this.retryWithBackoff(
					() => this.registerWithAPI(
						apiEndpoint,
						{
							uuid,
							deviceName,
							deviceType,
							deviceApiKey,
							applicationId,
							macAddress,
							osVersion,
							agentVersion,
						},
						provisioningApiKey
					),
					'Device Registration'
				);

				// Save server-assigned device ID and credentials
				this.deviceInfo.deviceId = response.id.toString();
				this.deviceInfo.mqttBrokerConfig = response.mqtt.brokerConfig;
				this.deviceInfo.apiTlsConfig = response.api?.tlsConfig;

				
				this.logger?.infoSync('Phase 1 complete: Device registered', {
					component: LogComponents.deviceManager,
					operation: 'provision',
					state: 'registered',
					deviceId: this.deviceInfo.deviceId,
				});
			} else {
				// Resume from registered state - device already exists in cloud
				this.logger?.infoSync('Phase 1: Skipping registration (already registered)', {
					component: LogComponents.deviceManager,
					operation: 'provision',
					state: currentState,
					deviceId: this.deviceInfo.deviceId,
				});
			}

			// Phase 2: Exchange keys - verify device can authenticate with deviceApiKey
			if (currentState !== 'provisioned') {
				this.logger?.infoSync('Phase 2: Exchanging keys', {
					component: LogComponents.deviceManager,
					operation: 'provision',
					state: 'key-exchanging',
          });
        
        // Mark as key-exchanging before API call
        this.deviceInfo.provisioningState = 'key-exchanging';
        await this.saveDeviceInfo();
        
        // Capture values for closure (TypeScript can't track through await/closures)
        const apiEndpoint = this.deviceInfo.apiEndpoint || 'http://localhost:3002';
        const uuid = this.deviceInfo.uuid;
        const deviceApiKey = this.deviceInfo.deviceApiKey!; // Guaranteed by line 387-396
        const challenge = response?.challenge; // Server-provided nonce for PoP
        
        // Wrap with retry logic for unreliable edge networks
        await this.retryWithBackoff(
          () => this.exchangeKeys(
            apiEndpoint,
            uuid,
            deviceApiKey,
            challenge  // Pass challenge for proof-of-possession
          ),
          'Key Exchange'
        );
				
				this.logger?.infoSync('Phase 2 complete: Key exchange successful', {
					component: LogComponents.deviceManager,
					operation: 'provision',
				});
			}

			// Phase 3: Remove provisioning key (one-time use complete)
			this.logger?.infoSync('Phase 3: Removing provisioning key', {
				component: LogComponents.deviceManager,
				operation: 'provision',
			});
			this.deviceInfo.provisioningApiKey = undefined;

			// Mark as provisioned (all phases complete)
			this.deviceInfo.provisioned = true;
			this.deviceInfo.provisioningState = 'provisioned';
			this.deviceInfo.registeredAt = Date.now();

			// Save to database
			await this.saveDeviceInfo();

			const vpnConfig = response?.vpn; // May be undefined if resuming
			this.logger?.infoSync('Device provisioned successfully', {
				component: LogComponents.deviceManager,
				operation: 'provision',
				state: 'provisioned',
				uuid: this.deviceInfo.uuid,
				deviceId: this.deviceInfo.deviceId,
				deviceName: this.deviceInfo.deviceName,
				applicationId: this.deviceInfo.applicationId,
				mqttBrokerHost: this.deviceInfo.mqttBrokerConfig?.host,
				vpnEnabled: vpnConfig?.enabled ?? false,
				vpnType: vpnConfig?.type,
				vpnData: vpnConfig?.type === 'tailscale' ? {
					tailnetName: vpnConfig.tailscale.tailnetName,
					authKey: vpnConfig.tailscale.authKey ? `${vpnConfig.tailscale.authKey.substring(0, 20)}...` : undefined,
					shieldsUp: vpnConfig.tailscale.shieldsUp,
					acceptRoutes: vpnConfig.tailscale.acceptRoutes,
					acceptDNS: vpnConfig.tailscale.acceptDNS,
					expiresAt: vpnConfig.tailscale.expiresAt,
				} : undefined,
			});

		// Phase 4: Setup Tailscale VPN if provided in response
		if (vpnConfig?.enabled && vpnConfig.type === 'tailscale') {
			this.logger?.infoSync('Setting up Tailscale VPN', {
				component: LogComponents.deviceManager,
				operation: 'provision',
				tailnetName: vpnConfig.tailscale.tailnetName,
			});

			try {
				const { TailscaleManager } = await import('../network/vpn/tailscale-manager.js');
				const tailscaleManager = new TailscaleManager(this.logger);
				
				// Check if Tailscale is installed, install if needed
				const isInstalled = await tailscaleManager.checkInstallation();
				if (!isInstalled) {
					await tailscaleManager.install();
				}

				// Configure and connect to Tailnet
				await tailscaleManager.configure({
					authKey: vpnConfig.tailscale.authKey,
					tailnetName: vpnConfig.tailscale.tailnetName,
					hostname: this.deviceInfo.deviceName,
					shieldsUp: vpnConfig.tailscale.shieldsUp ?? true,
					acceptRoutes: vpnConfig.tailscale.acceptRoutes ?? false,
					acceptDNS: vpnConfig.tailscale.acceptDNS ?? false,
				});

				// Get Tailscale IP
				const tailscaleIP = await tailscaleManager.getIP();

				this.logger?.infoSync('Tailscale VPN tunnel established successfully', {
					component: LogComponents.deviceManager,
					operation: 'provision',
					tailscaleIP,
					tailnetName: vpnConfig.tailscale.tailnetName,
				});
			} catch (vpnError) {
				// VPN setup failure is non-critical - device can still operate
				this.logger?.warnSync('Tailscale VPN setup failed (device will continue without VPN)', {
					component: LogComponents.deviceManager,
					operation: 'provision',
					error: vpnError instanceof Error ? vpnError.message : String(vpnError),
				});
			}
		}

			return this.getDeviceInfo();
		} catch (error: any) {
			// Reset to last successful state for idempotent retry
			const currentState = this.deviceInfo.provisioningState;
			if (currentState === 'registering') {
				// Phase 1 failed - reset to 'new' for full retry
				this.deviceInfo.provisioningState = 'new';
				await this.saveDeviceInfo();
			} else if (currentState === 'key-exchanging') {
				// Phase 2 failed - reset to 'registered' for partial retry
				this.deviceInfo.provisioningState = 'registered';
				await this.saveDeviceInfo();
			}
			
			this.logger?.errorSync(
				'Provisioning failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.deviceManager,
					operation: 'provision',
					state: currentState,
					resetTo: this.deviceInfo.provisioningState,
					note: 'State reset for idempotent retry',
				}
			);
			throw error;
		}
	}

	/**
	 * Register device with cloud API using provisioning key
	 * POST /api/v1/device/register
	 */
	private async registerWithAPI(
		apiEndpoint: string, 
		provisionRequest: ProvisionRequest,
		provisioningApiKey: string
	): Promise<ProvisionResponse> {
		if (!this.deviceInfo) {
			throw new Error('Device manager not initialized');
		}

		const url = buildApiEndpoint(apiEndpoint, '/device/register');
		
		// Generate idempotency key based on device UUID
		// Same UUID = same idempotency key = safe retries
		const idempotencyKey = `register-${this.deviceInfo.uuid}`;
		
		this.logger?.infoSync('Registering device with API', {
			component: LogComponents.deviceManager,
			operation: 'registerWithAPI',
			url,
			uuid: provisionRequest.uuid,
			deviceName: provisionRequest.deviceName,
			deviceType: provisionRequest.deviceType,
			idempotencyKey,
		});

		try {
			const response = await this.httpClient.post<ProvisionResponse>(url, provisionRequest, {
				headers: {
					...this.createAuthHeaders(provisioningApiKey),
					'X-Idempotency-Key': idempotencyKey,
				},
			});

			if (!response.ok) {
				const errorText = await response.json().catch(() => ({ message: response.statusText }));
				throw new Error(`API returned ${response.status}: ${JSON.stringify(errorText)}`);
			}

			const result = await response.json();

			return result;
		} catch (error: any) {
			this.logger?.errorSync(
				'Registration failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.deviceManager,
					operation: 'registerWithAPI',
				}
			);
			throw new Error(`Failed to register device: ${error.message}`);
		}
	}

	/**
	 * Exchange keys - verify device can authenticate with deviceApiKey
	 * POST /api/${API_VERSION}/device/:uuid/key-exchange
	 * 
	 * Security: Uses proof-of-possession (HMAC challenge-response) instead of
	 * transmitting deviceApiKey. This prevents:
	 * - Replay attacks (challenge is single-use)
	 * - Key interception (key never transmitted)
	 * - Circular authentication (proof != credential)
	 * 
	 * Fallback: If server doesn't provide challenge, uses legacy v1 method
	 * (insecure but backward compatible)
	 */
	async exchangeKeys(
		apiEndpoint: string,
		uuid: string,
		deviceApiKey: string,
		challenge?: string  // Server-provided nonce from registration response
	): Promise<void> {
		const url = buildApiEndpoint(apiEndpoint, `/device/${uuid}/key-exchange`);
		
		// Generate idempotency key based on device UUID and operation
		const idempotencyKey = `key-exchange-${uuid}`;
		
		// Use PoP if server provided challenge
		const useSecureProof = !!challenge;
		
		this.logger?.infoSync('Exchanging keys for device', {
			component: LogComponents.deviceManager,
			operation: 'exchangeKeys',
			uuid,
			authMethod: useSecureProof ? 'proof-of-possession' : 'bcrypt-fallback',
			idempotencyKey,
		});

		try {
			let requestBody: KeyExchangeRequest;
			let headers: Record<string, string>;
			
			if (useSecureProof) {
				// SECURE: Proof-of-possession (HMAC challenge-response)
				const proof = computeKeyExchangeProof(challenge!, deviceApiKey, uuid);
				
				requestBody = {
					uuid,
					deviceApiKey,  // Include for request validation
					challenge: challenge!,
					proof, // HMAC-SHA256(deviceApiKey.secret, challenge:uuid)
				};
				
				// Use deviceApiKey for auth header (server validates proof separately)
				headers = this.createAuthHeaders(deviceApiKey);
				
				this.logger?.debugSync('Using secure proof-of-possession', {
					component: LogComponents.deviceManager,
					operation: 'exchangeKeys',
					challengeLength: challenge!.length,
					proofLength: proof.length,
				});
			} else {
				// FALLBACK: Legacy bcrypt method (backward compatibility)
				this.logger?.warnSync('Server did not provide challenge - using bcrypt fallback', {
					component: LogComponents.deviceManager,
					operation: 'exchangeKeys',
					note: 'Transmitting deviceApiKey directly (less secure)',
				});
				
				requestBody = {
					uuid,
					deviceApiKey, // Transmit key directly for bcrypt verification
				};
				
				headers = this.createAuthHeaders(deviceApiKey);
			}
			
			// Add idempotency key to prevent duplicate key exchange on retries
			headers['X-Idempotency-Key'] = idempotencyKey;
			
			const response = await this.httpClient.post(url, requestBody, { headers });

			if (!response.ok) {
				const errorText = await response.json().catch(() => ({ message: response.statusText }));
				throw new Error(`Key exchange failed ${response.status}: ${JSON.stringify(errorText)}`);
			}

			const result = await response.json();
			this.logger?.infoSync('Key exchange successful', {
				component: LogComponents.deviceManager,
				operation: 'exchangeKeys',
				authMethod: useSecureProof ? 'proof-of-possession' : 'bcrypt-fallback',
			});
		} catch (error: any) {
			this.logger?.errorSync(
				'Key exchange failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.deviceManager,
					operation: 'exchangeKeys',
				}
			);
			throw new Error(`Failed to exchange keys: ${error.message}`);
		}
	}

	/**
	 * Check if device already exists and try key exchange
	 * GET /api/${API_VERSION}/device/:uuid
	 */
	async fetchDevice(apiEndpoint: string, uuid: string, apiKey: string): Promise<any> {
		const url = buildApiEndpoint(apiEndpoint, `/devices/${uuid}`);
		
		try {
			const response = await this.httpClient.get(url, {
				headers: this.createAuthHeaders(apiKey),
			});

			if (!response.ok) {
				if (response.status === 404) {
					return null; // Device not found
				}
				const errorText = await response.json().catch(() => ({ message: response.statusText }));
				throw new Error(`API returned ${response.status}: ${JSON.stringify(errorText)}`);
			}

			return await response.json();
		} catch (error: any) {
			this.logger?.errorSync(
				'Failed to fetch device',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.deviceManager,
					operation: 'fetchDevice',
				}
			);
			return null;
		}
	}

	/**
	 * Update device name
	 */
	async updateDeviceName(name: string): Promise<void> {
		if (!this.deviceInfo) {
			throw new Error('Device manager not initialized');
		}

		this.deviceInfo.deviceName = name;
		await this.saveDeviceInfo();
	}

	/**
	 * Update API endpoint
	 */
	async updateAPIEndpoint(endpoint: string): Promise<void> {
		if (!this.deviceInfo) {
			throw new Error('Device manager not initialized');
		}

		this.deviceInfo.apiEndpoint = endpoint;
		await this.saveDeviceInfo();
	}

	/**
	 * Update agent version
	 */
	async updateAgentVersion(version: string): Promise<void> {
		if (!this.deviceInfo) {
			throw new Error('Device manager not initialized');
		}

		this.deviceInfo.agentVersion = version;
		await this.saveDeviceInfo();
	}

	/**
	 * Reset device (unprovision)
	 * Useful for testing or re-provisioning
	 * Keeps UUID and deviceApiKey, clears server registration and MQTT credentials
	 */
	async reset(): Promise<void> {
		if (!this.deviceInfo) {
			throw new Error('Device manager not initialized');
		}

		// Clear server-assigned values
		this.deviceInfo.deviceId = undefined;
		this.deviceInfo.deviceName = undefined;
		this.deviceInfo.provisioningApiKey = undefined;
		this.deviceInfo.apiKey = undefined;
		this.deviceInfo.apiEndpoint = undefined;
		this.deviceInfo.registeredAt = undefined;
		this.deviceInfo.provisioned = false;
		this.deviceInfo.provisioningState = 'new';
		this.deviceInfo.applicationId = undefined;
		
		// Clear MQTT credentials (these are cloud-assigned)
		this.deviceInfo.mqttBrokerConfig = undefined;

		await this.saveDeviceInfo();

		this.logger?.infoSync('Device reset (unprovisioned)', {
			component: LogComponents.deviceManager,
			operation: 'reset',
			note: 'UUID and deviceApiKey preserved for re-registration. MQTT credentials cleared.',
		});
	}
	
	/**
	 * Factory reset - complete cleanup of all device data
	 * WARNING: This will delete all apps, services, state snapshots, and sensor data
	 * Only UUID will be preserved for hardware identification
	 */
	async factoryReset(): Promise<void> {
		if (!this.deviceInfo) {
			throw new Error('Device manager not initialized');
		}

		this.logger?.warnSync('Performing factory reset - all data will be deleted', {
			component: LogComponents.deviceManager,
			operation: 'factoryReset',
		});

		// First, deprovision from cloud if device is provisioned
		// This notifies the cloud API so the device can be re-provisioned later
		if (this.deviceInfo.provisioned && this.deviceInfo.apiEndpoint) {
			try {
				this.logger?.infoSync('Deprovisioning from cloud before factory reset', {
					component: LogComponents.deviceManager,
					operation: 'factoryReset',
					apiEndpoint: this.deviceInfo.apiEndpoint,
				});
				
				const url = buildApiEndpoint(this.deviceInfo.apiEndpoint, `/devices/${this.deviceInfo.uuid}`);
				const response = await this.httpClient.get(url, {
					headers: this.createAuthHeaders(this.deviceInfo.deviceApiKey!),
				});

				if (!response.ok) {
					this.logger?.warnSync('Cloud deprovision failed, continuing with local reset', {
						component: LogComponents.deviceManager,
						operation: 'factoryReset',
						status: response.status,
						note: 'Device will be reset locally. Cloud may still think device is provisioned.',
					});
				} else {
					this.logger?.infoSync('Cloud deprovision successful', {
						component: LogComponents.deviceManager,
						operation: 'factoryReset',
					});
				}
			} catch (error: any) {
				this.logger?.warnSync('Cloud deprovision error, continuing with local reset', {
					component: LogComponents.deviceManager,
					operation: 'factoryReset',
					error: error.message,
					note: 'Device will be reset locally. Cloud may still think device is provisioned.',
				});
			}
		}

		// Use centralized database factory reset
		// This is safer than direct table deletion:
		// - Schema changes don't break reset logic
		// - Permissions and journaling centralized
		// - Future: backup before delete, confirmation prompts
		const { factoryReset: dbFactoryReset } = await import('../db/connection.js');
		await dbFactoryReset(this.logger);
		
		// Reset device info but preserve UUID for hardware identification
		const preservedUuid = this.deviceInfo.uuid;
		
		this.deviceInfo.deviceId = undefined;
		this.deviceInfo.deviceName = undefined;
		this.deviceInfo.deviceType = undefined;
		this.deviceInfo.deviceApiKey = undefined; // Also clear device key for full reset
		this.deviceInfo.provisioningApiKey = undefined;
		this.deviceInfo.apiKey = undefined;
		this.deviceInfo.apiEndpoint = undefined;
		this.deviceInfo.registeredAt = undefined;
		this.deviceInfo.provisioned = false;
		this.deviceInfo.provisioningState = 'new';
		this.deviceInfo.applicationId = undefined;
		this.deviceInfo.macAddress = undefined;
		this.deviceInfo.osVersion = undefined;
		this.deviceInfo.agentVersion = undefined;
		this.deviceInfo.mqttBrokerConfig = undefined;
		this.deviceInfo.uuid = preservedUuid; // Restore UUID

		await this.saveDeviceInfo();

		this.logger?.warnSync('Factory reset complete - device returned to initial state', {
			component: LogComponents.deviceManager,
			operation: 'factoryReset',
			uuid: preservedUuid,
			note: 'Only UUID preserved. All apps, services, and data deleted. Device can be re-provisioned.',
		});
	}
}

export default DeviceManager;




