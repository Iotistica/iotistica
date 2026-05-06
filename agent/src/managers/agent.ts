/**
 * Agent provisioning manager for standalone container-manager
 * Implements two-phase authentication inspired by Balena Supervisor
 * 
 * Flow:
 * 1. Generate UUID and apiKey locally
 * 2. Use provisioningApiKey (fleet-level) to register agent
 * 3. Exchange provisioningApiKey for apiKey authentication
 * 4. Remove provisioningApiKey (one-time use)
 * 5. Setup VPN tunnel if provided in provisioning response
 * 
 * Refactored for testability with dependency injection:
 * - HttpClient abstraction for API calls (no global fetch stubbing needed)
 * - DatabaseClient abstraction for database operations (no DB driver stubbing needed)
 */

import type { 
	AgentInfo, 
	ProvisioningConfig, 
	ProvisionRequest, 
	ProvisionResponse,
	KeyExchangeRequest
} from './types';
import { AgentModel } from '../db/models/agent.model';
import { buildApiEndpoint, getPackageVersion } from '../utils/api-utils';
import { 
	DefaultUuidGenerator, 
	generateAPIKey, 
	getAPIKeyFingerprint, 
	parseAPIKey,
	type UuidGenerator 
} from '../utils/crypto';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { HttpClient } from '../lib/http-client.js';
import { createHttpClient, FetchHttpClient } from '../lib/http-client.js';
import type { DatabaseClient } from '../db/client.js';
import { SqliteDatabaseClient } from '../db/client.js';
import { PopCryptoManager } from '../security/pop-crypto.js';

export class AgentManager {
	private agentInfo: AgentInfo | null = null;
	private logger?: AgentLogger;
	private httpClient: HttpClient;
	private dbClient: DatabaseClient;
	private uuidGenerator: UuidGenerator;
	private popCrypto?: PopCryptoManager;

	// Retry configuration for unreliable edge networks
	private readonly PROVISIONING_TIMEOUT_MS = 30000; // 30s per attempt
	private readonly MAX_RETRY_ATTEMPTS = 5; // Total attempts: 1 initial + 5 retries
	private readonly INITIAL_RETRY_DELAY_MS = 1000; // Start at 1s
	private readonly MAX_RETRY_DELAY_MS = 32000; // Cap at 32s

	constructor(
		logger?: AgentLogger,
		httpClient?: HttpClient,
		dbClient?: DatabaseClient,
		uuidGenerator?: UuidGenerator,
		cloudApiEndpoint?: string
	) {
		this.logger = logger;
		this.httpClient = httpClient || this.createHttpClient(cloudApiEndpoint);
		this.dbClient = dbClient || new SqliteDatabaseClient();
		this.uuidGenerator = uuidGenerator || new DefaultUuidGenerator();
	}

	/**
	 * Create HTTP client with TLS configuration for the API endpoint
	 * Uses centralized factory for consistent behavior
	 */
	private createHttpClient(cloudApiEndpoint?: string): HttpClient {
		// If no endpoint provided, use default unencrypted client
		if (!cloudApiEndpoint) {
			return new FetchHttpClient();
		}

		return createHttpClient(cloudApiEndpoint, {
			defaultTimeout: this.PROVISIONING_TIMEOUT_MS
		});
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
					component: LogComponents.agentManager,
					operation: 'retryWithBackoff',
					attempt: attempt + 1,
					maxAttempts: this.MAX_RETRY_ATTEMPTS + 1,
					timeoutMs: timeout,
				});

				// Execute operation with timeout
				const result = await this.withTimeout(operation(), timeout, operationName);
				
				if (attempt > 0) {
					this.logger?.infoSync(`${operationName} succeeded after retries`, {
						component: LogComponents.agentManager,
						operation: 'retryWithBackoff',
						attempt: attempt + 1,
					});
				}
				
				return result;
			} catch (error: any) {
				lastError = error instanceof Error ? error : new Error(String(error));
				
				if (attempt < this.MAX_RETRY_ATTEMPTS) {
					this.logger?.warnSync(`${operationName} failed, retrying`, {
						component: LogComponents.agentManager,
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
							component: LogComponents.agentManager,
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
	 * Initialize agent manager and load agent info from database
	 */
	async initialize(): Promise<void> {
		// Initialize encryption for secure credential storage in persisted location
		// Use DATA_DIR env var (systemd: /var/lib/iotistic/agent, Docker: /app/data)
		// CRITICAL: Absolute path required so encryption key persists across rebuilds
		const dataDir = process.env.DATA_DIR || '/app/data';
		
		AgentModel.initializeEncryption(dataDir);

		// Initialize PoP crypto (generates keys if needed)
		this.popCrypto = new PopCryptoManager(dataDir, this.logger);
		await this.popCrypto.initialize();

		await this.loadAgentInfo();

		if (!this.agentInfo) {
			// Create new agent with generated UUID and apiKey
			const newApiKey = generateAPIKey('v2'); // Generate v2 versioned key
			const keyMetadata = parseAPIKey(newApiKey);
			
				this.agentInfo = {
				uuid: process.env.DEVICE_UUID || this.uuidGenerator.generate(), // Use pre-assigned UUID for virtual agents
				apiKey: newApiKey,
				provisioned: false,
				provisioningState: 'new',
				agentVersion: process.env.AGENT_VERSION || getPackageVersion(),
			};
			await this.saveAgentInfo();
			this.logger?.infoSync('New agent created with versioned API key', {
				component: LogComponents.agentManager,
				operation: 'initialize',
				uuid: this.agentInfo.uuid,
				keyVersion: keyMetadata?.version,
				keyFingerprint: getAPIKeyFingerprint(newApiKey),
				keyId: keyMetadata?.kid,
			});
		} else {
			// Update agent version on every startup (BEFORE logging)
			const currentVersion = process.env.AGENT_VERSION || getPackageVersion();
			if (this.agentInfo.agentVersion !== currentVersion) {
				const oldVersion = this.agentInfo.agentVersion;
				this.agentInfo.agentVersion = currentVersion;
				await this.saveAgentInfo();
				this.logger?.infoSync('Agent version updated', {
					component: LogComponents.agentManager,
					operation: 'initialize',
					oldVersion,
					newVersion: currentVersion,
				});
			}
			
			// Log agent info with key metadata (safe fingerprint, no secrets)
			const keyMetadata = this.agentInfo.apiKey 
				? parseAPIKey(this.agentInfo.apiKey) 
				: null;
			
			this.logger?.infoSync('agent loaded', {
				component: LogComponents.agentManager,
				operation: 'initialize',
				uuid: this.agentInfo.uuid,
				provisioned: this.agentInfo.provisioned,
				provisioningState: this.agentInfo.provisioningState || 'unknown',
				hasAgentApiKey: !!this.agentInfo.apiKey,
				keyVersion: keyMetadata?.version,
				keyFingerprint: this.agentInfo.apiKey 
					? getAPIKeyFingerprint(this.agentInfo.apiKey) 
					: undefined,
				hasProvisioningKey: !!this.agentInfo.provisioningApiKey,
				agentVersion: this.agentInfo.agentVersion,
			});
		}
	}

	/**
	 * Load agent info from database
	 */
	private async loadAgentInfo(): Promise<void> {
		const record = await this.dbClient.loadAgent();
		if (record) {
			// Debug: log record before parsing
			this.logger?.debugSync('Record loaded from database', {
				component: LogComponents.agentManager,
				operation: 'loadAgentInfo',
				hasRecord: !!record,
				hasApiTlsConfig: !!record.apiTlsConfig,
				apiTlsConfigType: typeof record.apiTlsConfig,
				apiTlsConfigLength: record.apiTlsConfig?.length
			});

			this.agentInfo = {
				uuid: record.uuid,
				name: record.name || undefined,
				type: record.type || undefined,
				apiKey: record.apiKey || record.deviceApiKey || undefined,
				provisioningApiKey: record.provisioningApiKey || undefined,
				apiEndpoint: record.apiEndpoint || undefined,
				registeredAt: record.registeredAt || undefined,
				provisioned: !!record.provisioned,
				provisioningState: (record.provisioningState as any) || (record.provisioned ? 'provisioned' : 'new'),
				tenantId: record.tenantId || undefined,
			applicationId: record.applicationId || undefined,
			macAddress: record.macAddress || undefined,
			osVersion: record.osVersion || undefined,
			agentVersion: record.agentVersion || undefined,

			mqttBrokerConfig: record.mqttBrokerConfig ? JSON.parse(record.mqttBrokerConfig) : undefined,
			apiTlsConfig: record.apiTlsConfig ? JSON.parse(record.apiTlsConfig) : undefined,
		};
		
	}
}
	/**
	 * Save agent info to database
	 */
	private async saveAgentInfo(): Promise<void> {
		if (!this.agentInfo) {
			throw new Error('No agent info to save');
		}

		const data = {
			uuid: this.agentInfo.uuid,
			name: this.agentInfo.name || null,
			type: this.agentInfo.type || null,
			deviceApiKey: this.agentInfo.apiKey || null,
			provisioningApiKey: this.agentInfo.provisioningApiKey || null,
			apiKey: this.agentInfo.apiKey || null,
			apiEndpoint: this.agentInfo.apiEndpoint || null,
			registeredAt: this.agentInfo.registeredAt || null,
			provisioned: this.agentInfo.provisioned,
			provisioningState: this.agentInfo.provisioningState || 'new',
			tenantId: this.agentInfo.tenantId || null,
			applicationId: this.agentInfo.applicationId || null,
			macAddress: this.agentInfo.macAddress || null,
			osVersion: this.agentInfo.osVersion || null,
			agentVersion: this.agentInfo.agentVersion || null,
			mqttBrokerConfig: this.agentInfo.mqttBrokerConfig ? JSON.stringify(this.agentInfo.mqttBrokerConfig) : null,
			apiTlsConfig: this.agentInfo.apiTlsConfig ? JSON.stringify(this.agentInfo.apiTlsConfig) : null,
			updatedAt: new Date().toISOString(),
		};
		
		await this.dbClient.saveAgent(data);
	}

	/**
	 * Persist tenantId for already provisioned agents (migration/repair path)
	 */
	async setTenantId(tenantId: string): Promise<void> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		this.agentInfo.tenantId = tenantId;
		await this.saveAgentInfo();
	}

	/**
	 * Get current agent info
	 */
	getAgentInfo(): AgentInfo {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}
		
		return { ...this.agentInfo };
	}

	/**
	 * Check if agent is provisioned
	 */
	isProvisioned(): boolean {
		return this.agentInfo?.provisioned === true;
	}

	/**
	 * Create authorization headers for regular authenticated API requests (JWT).
	 */
	private createAuthHeaders(apiKey: string): Record<string, string> {
		return {
			'Authorization': `Bearer ${apiKey}`,
		};
	}

	/**
	 * Create headers for Phase 1 agent registration (provisioning key).
	 * Uses x-provisioning-key to distinguish from JWT and agent-key traffic.
	 */
	private createProvisioningHeaders(provisioningKey: string): Record<string, string> {
		return {
			'x-provisioning-key': provisioningKey,
		};
	}

	/**
	 * Create headers for Phase 2 key exchange (agent API key).
	 * Uses x-device-key to distinguish from JWT and provisioning-key traffic.
	 */
	private createAgentKeyHeaders(agentKey: string): Record<string, string> {
		return {
			'x-device-key': agentKey,
		};
	}

	/**
	 * Mark agent as running in local mode (no cloud provisioning needed)
	 */
	async markAsLocalMode(): Promise<void> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		this.agentInfo.provisioned = false; // Explicitly mark as NOT cloud-provisioned
		this.agentInfo.provisioningState = 'new';
		this.agentInfo.name = this.agentInfo.name || `agent-${this.agentInfo.uuid.slice(0, 8)}`;
		this.agentInfo.type = this.agentInfo.type || 'standalone';
		this.agentInfo.agentVersion = process.env.AGENT_VERSION || getPackageVersion(); // Update agent version
		
		await this.saveAgentInfo();

		this.logger?.infoSync('Agent configured for local mode', {
			component: LogComponents.agentManager,
			operation: 'markAsLocalMode',
			uuid: this.agentInfo.uuid,
			agentName: this.agentInfo.name,
			agentVersion: this.agentInfo.agentVersion,
		});
	}

	/**
	 * Provision agent using two-phase authentication
	 * Phase 1: Register agent using provisioningApiKey
	 * Phase 2: Exchange keys and remove provisioning key
	 */
	async provision(config: ProvisioningConfig): Promise<AgentInfo> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		if (!config.provisioningApiKey) {
			throw new Error('provisioningApiKey is required for agent provisioning');
		}

		// Ensure API key exists (generate v2 if missing)
		if (!this.agentInfo.apiKey) {
			this.agentInfo.apiKey = generateAPIKey('v2');
			const keyMetadata = parseAPIKey(this.agentInfo.apiKey);
			this.logger?.infoSync('Generated new API key for provisioning', {
				component: LogComponents.agentManager,
				operation: 'provision',
				keyVersion: keyMetadata?.version,
				keyId: keyMetadata?.kid,
				keyFingerprint: getAPIKeyFingerprint(this.agentInfo.apiKey),
			});
		}

			// Update agent metadata
		this.agentInfo.name = config.name || this.agentInfo.name || `agent-${this.agentInfo.uuid.slice(0, 8)}`;
		this.agentInfo.type = config.type || this.agentInfo.type || 'generic';
		this.agentInfo.apiEndpoint = config.apiEndpoint || this.agentInfo.apiEndpoint;
		this.agentInfo.provisioningApiKey = config.provisioningApiKey;
		this.agentInfo.applicationId = config.applicationId;
		this.agentInfo.macAddress = config.macAddress;
		this.agentInfo.osVersion = config.osVersion;
		this.agentInfo.agentVersion = config.agentVersion;

		// UUID is immutable after cloud registration (prevents agent identity hijacking)
		// Only allow UUID override for new/unprovisioned agents
		if (config.uuid && config.uuid !== this.agentInfo.uuid) {
			const currentState = this.agentInfo.provisioningState || 'new';
			const isRegistered = currentState !== 'new' && currentState !== 'registering';
			
			if (isRegistered) {
				// Agent already registered with cloud - UUID cannot be changed
				this.logger?.errorSync(
					'Attempt to change UUID after cloud registration (rejected)',
					new Error('UUID is immutable after provisioning'),
					{
						component: LogComponents.agentManager,
						operation: 'provision',
						currentUuid: this.agentInfo.uuid,
						attemptedUuid: config.uuid,
						provisioningState: currentState,
					}
				);
				throw new Error(
					`UUID cannot be changed after cloud registration. ` +
					`Current UUID: ${this.agentInfo.uuid}, ` +
					`Attempted UUID: ${config.uuid}. ` +
					`Use factory reset to re-provision with a new UUID.`
				);
			} else {
				// Agent not yet registered - UUID change allowed
				this.logger?.warnSync('Changing agent UUID before registration', {
					component: LogComponents.agentManager,
					operation: 'provision',
					oldUuid: this.agentInfo.uuid,
					newUuid: config.uuid,
					note: 'UUID override allowed only before cloud registration',
				});
				this.agentInfo.uuid = config.uuid;
			}
		}

		try {
			const currentState = this.agentInfo.provisioningState || 'new';
			
			// Check if we're resuming from a partial failure
			if (currentState !== 'new' && currentState !== 'provisioned') {
				this.logger?.warnSync('Resuming incomplete provisioning', {
					component: LogComponents.agentManager,
					operation: 'provision',
					currentState,
					note: 'Previous provisioning attempt failed mid-flight - resuming from last checkpoint',
				});
			}
			
			// Phase 1: Register agent with cloud API (idempotent)
			let response: ProvisionResponse | undefined;
			
			if (currentState === 'new' || currentState === 'registering') {
				this.logger?.infoSync('Phase 1: Registering agent with provisioning key', {
					component: LogComponents.agentManager,
					operation: 'provision',
					state: 'registering',
				});
				
				// Mark as registering before API call
				this.agentInfo.provisioningState = 'registering';
				await this.saveAgentInfo();
				
				// Capture values for closure (TypeScript can't track through await/closures)
				const apiEndpoint = this.agentInfo.apiEndpoint || 'http://localhost:3002';
				const uuid = this.agentInfo.uuid;
				const agentName = this.agentInfo.name!; // Guaranteed by line 401
				const agentType = this.agentInfo.type!; // Guaranteed by line 402
				const deviceApiKey = this.agentInfo.apiKey!; // Guaranteed by line 387-396
				const applicationId = this.agentInfo.applicationId;
				const macAddress = this.agentInfo.macAddress;
				const osVersion = this.agentInfo.osVersion;
				const agentVersion = this.agentInfo.agentVersion;
				const provisioningApiKey = this.agentInfo.provisioningApiKey!; // Guaranteed by line 381
				
				// Get public key for PoP if crypto initialized
				const agentPublicKey = this.popCrypto?.getPublicKey();
				
				if (agentPublicKey) {
					this.logger?.infoSync('Registering with PoP public key', {
						component: LogComponents.agentManager,
						operation: 'provision',
						keyFingerprint: this.popCrypto?.getKeyFingerprint()
					});
				} else {
					this.logger?.warnSync('⚠️ Registering without PoP (using legacy bcrypt)', {
						component: LogComponents.agentManager,
						operation: 'provision',
						reason: 'PoP crypto not initialized'
					});
				}
				
				// Wrap with retry logic for unreliable edge networks
				response = await this.retryWithBackoff(
					() => this.registerWithAPI(
						apiEndpoint,
						{
							uuid,
							deviceName: agentName,
							deviceType: agentType,
							deviceApiKey: deviceApiKey,
							devicePublicKey: agentPublicKey,
							applicationId,
							macAddress,
							osVersion,
							agentVersion,
						},
						provisioningApiKey
					),
					'Agent Registration'
				);

				// Save server-assigned tenant ID and credentials
				this.agentInfo.tenantId = response.tenantId; // Save tenant ID for MQTT topic construction
				this.agentInfo.mqttBrokerConfig = response.mqtt.brokerConfig;
				this.agentInfo.apiTlsConfig = response.api?.tlsConfig;
				
				// Cache tenant ID immediately for MQTT topic construction
				if (response.tenantId) {
					const { setTenantId } = await import('../mqtt/topics.js');
					setTenantId(response.tenantId);
				}
				
				// Update agent name/type from server response (critical for virtual agents)
				// Virtual agents have pre-assigned names in the database that must be preserved
				if (response.name) {
					this.agentInfo.name = response.name;
				}
				if (response.type) {
					this.agentInfo.type = response.type;
				}

				// Log full provisioning response for troubleshooting
				this.logger?.infoSync('Provisioning response received', {
					component: LogComponents.agentManager,
					operation: 'provision',
					responseKeys: Object.keys(response),
					tenantId: response.tenantId,
					mqttKeys: Object.keys(response.mqtt || {}),
					brokerConfigKeys: Object.keys(response.mqtt?.brokerConfig || {}),
					brokerConfig: response.mqtt?.brokerConfig,
					hasUseTls: response.mqtt?.brokerConfig?.useTls,
					hasVerifyCertificate: response.mqtt?.brokerConfig?.verifyCertificate,
					protocol: response.mqtt?.brokerConfig?.protocol,
					host: response.mqtt?.brokerConfig?.host,
					port: response.mqtt?.brokerConfig?.port
				});
				
				this.logger?.infoSync('Phase 1 complete: Agent registered', {
					component: LogComponents.agentManager,
					operation: 'provision',
					state: 'registered',
					uuid: this.agentInfo.uuid,
				});
			} else {
				// Resume from registered state - agent already exists in cloud
				this.logger?.infoSync('Phase 1: Skipping registration (already registered)', {
					component: LogComponents.agentManager,
					operation: 'provision',
					state: currentState,
					uuid: this.agentInfo.uuid,
				});
			}

			// Phase 2: Exchange keys - verify agent can authenticate with apiKey
			if (currentState !== 'provisioned') {
				this.logger?.infoSync('Phase 2: Exchanging keys', {
					component: LogComponents.agentManager,
					operation: 'provision',
					state: 'key-exchanging',
          });
        
        // Mark as key-exchanging before API call
        this.agentInfo.provisioningState = 'key-exchanging';
        await this.saveAgentInfo();
        
        // Capture values for closure (TypeScript can't track through await/closures)
        const apiEndpoint = this.agentInfo.apiEndpoint || 'http://localhost:3002';
        const uuid = this.agentInfo.uuid;
        const deviceApiKey = this.agentInfo.apiKey!; // Guaranteed by line 387-396
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
					component: LogComponents.agentManager,
					operation: 'provision',
				});
			}

			// Phase 3: Remove provisioning key (one-time use complete)
			this.logger?.infoSync('Phase 3: Removing provisioning key', {
				component: LogComponents.agentManager,
				operation: 'provision',
			});
			this.agentInfo.provisioningApiKey = undefined;

			// Mark as provisioned (all phases complete)
			this.agentInfo.provisioned = true;
			this.agentInfo.provisioningState = 'provisioned';
			this.agentInfo.registeredAt = Date.now();
			
			// Store VPN status from provisioning response
			const vpnConfig = response?.vpn;
			this.agentInfo.vpnEnabled = !!(vpnConfig?.enabled);

			// Save to database
			await this.saveAgentInfo();

			this.logger?.infoSync('Agent provisioned successfully', {
				component: LogComponents.agentManager,
				operation: 'provision',
				state: 'provisioned',
				uuid: this.agentInfo.uuid,
				agentName: this.agentInfo.name,
				applicationId: this.agentInfo.applicationId,
				mqttBrokerHost: this.agentInfo.mqttBrokerConfig?.host,
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
				component: LogComponents.agentManager,
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
					hostname: this.agentInfo.name,
					shieldsUp: vpnConfig.tailscale.shieldsUp ?? true,
					acceptRoutes: vpnConfig.tailscale.acceptRoutes ?? false,
					acceptDNS: vpnConfig.tailscale.acceptDNS ?? false,
				});

				// Get Tailscale IP
				const tailscaleIP = await tailscaleManager.getIP();

				this.logger?.infoSync('Tailscale VPN tunnel established successfully', {
					component: LogComponents.agentManager,
					operation: 'provision',
					tailscaleIP,
					tailnetName: vpnConfig.tailscale.tailnetName,
				});
			} catch (vpnError) {
				// VPN setup failure is non-critical - agent can still operate
				this.logger?.warnSync('Tailscale VPN setup failed (agent will continue without VPN)', {
					component: LogComponents.agentManager,
					operation: 'provision',
					error: vpnError instanceof Error ? vpnError.message : String(vpnError),
				});
			}
		}

			return this.getAgentInfo();
		} catch (error: any) {
			// Reset to last successful state for idempotent retry
			const currentState = this.agentInfo.provisioningState;
			if (currentState === 'registering') {
				// Phase 1 failed - reset to 'new' for full retry
				this.agentInfo.provisioningState = 'new';
				await this.saveAgentInfo();
			} else if (currentState === 'key-exchanging') {
				// Phase 2 failed - reset to 'registered' for partial retry
				this.agentInfo.provisioningState = 'registered';
				await this.saveAgentInfo();
			}
			
			this.logger?.errorSync(
				'Provisioning failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agentManager,
					operation: 'provision',
					state: currentState,
					resetTo: this.agentInfo.provisioningState,
					note: 'State reset for idempotent retry',
				}
			);
			throw error;
		}
	}

	/**
	 * Register agent with cloud API using provisioning key
	 * POST /api/v1/device/register
	 */
	private async registerWithAPI(
		apiEndpoint: string, 
		provisionRequest: ProvisionRequest,
		provisioningApiKey: string
	): Promise<ProvisionResponse> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		const url = buildApiEndpoint(apiEndpoint, '/device/register');
		
		// Generate idempotency key based on agent UUID
		// Same UUID = same idempotency key = safe retries
		const idempotencyKey = `register-${this.agentInfo.uuid}`;
		
		this.logger?.infoSync('Registering agent with API', {
			component: LogComponents.agentManager,
			operation: 'registerWithAPI',
			url,
			uuid: provisionRequest.uuid,
			agentName: provisionRequest.deviceName,
			agentType: provisionRequest.deviceType,
			idempotencyKey,
		});

		try {
			const response = await this.httpClient.post<ProvisionResponse>(url, provisionRequest, {
				headers: {
					...this.createProvisioningHeaders(provisioningApiKey),
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
					component: LogComponents.agentManager,
					operation: 'registerWithAPI',
				}
			);
			throw new Error(`Failed to register agent: ${error.message}`);
		}
	}

	/**
	 * Exchange keys - verify agent can authenticate with apiKey
	 * POST /api/${API_VERSION}/device/:uuid/key-exchange
	 * 
	 * Security: Uses asymmetric proof-of-possession (Ed25519 challenge-response).
	 * - Agent signs challenge with Ed25519 private key (never transmitted)
	 * - Server verifies signature with public key (registered during provisioning)
	 * - UUID bound into signature payload to prevent cross-agent replay
	 * 
	 * This prevents:
	 * - Replay attacks (challenge is single-use, UUID-bound)
	 * - Key interception (private key never leaves agent)
	 * - Cross-device replay (UUID bound into signed payload)
	 * - Circular authentication (proof != credential)
	 * 
	 * Requirements:
	 * - Server must provide challenge
	 * - Agent must have PoP crypto initialized (Ed25519 key pair)
	 * - No fallback to symmetric crypto (bcrypt deprecated)
	 */
	async exchangeKeys(
		apiEndpoint: string,
		uuid: string,
		deviceApiKey: string,
		challenge?: string  // Server-provided nonce from registration response
	): Promise<void> {
		const url = buildApiEndpoint(apiEndpoint, `/device/${uuid}/key-exchange`);
		
		// Generate idempotency key based on agent UUID and operation
		const idempotencyKey = `key-exchange-${uuid}`;
		
		// PoP is mandatory - fail if requirements not met
		if (!challenge) {
			throw new Error('Server did not provide challenge - PoP authentication required');
		}
		
		if (!this.popCrypto?.isEnabled()) {
			throw new Error('PoP crypto not initialized - cannot authenticate');
		}
		
		this.logger?.infoSync('Exchanging keys for agent', {
			component: LogComponents.agentManager,
			operation: 'exchangeKeys',
			uuid,
			authMethod: 'proof-of-possession',
			challengeLength: challenge.length,
			idempotencyKey,
		});

		try {
			// SECURE: Proof-of-possession with Ed25519 signature (mandatory)
			// Binds agent UUID to challenge to prevent cross-agent replay
			const signature = this.popCrypto.signChallenge(challenge, uuid);
			
			const requestBody: KeyExchangeRequest = {
				uuid,
				signature,
			};
			
			const headers = this.createAgentKeyHeaders(deviceApiKey);
			headers['X-Idempotency-Key'] = idempotencyKey;
			
			this.logger?.infoSync('Using Ed25519 PoP signature', {
				component: LogComponents.agentManager,
				operation: 'exchangeKeys',
				challengeLength: challenge.length,
				signatureLength: signature.length,
				keyFingerprint: this.popCrypto.getKeyFingerprint()
			});
		
		const response = await this.httpClient.post(url, requestBody, { headers });

		if (!response.ok) {
			const errorText = await response.json().catch(() => ({ message: response.statusText }));
			throw new Error(`Key exchange failed ${response.status}: ${JSON.stringify(errorText)}`);
		}

		const result = await response.json();
		this.logger?.infoSync('Key exchange successful', {
			component: LogComponents.agentManager,
			operation: 'exchangeKeys',
			authMethod: 'proof-of-possession',
		});
	} catch (error: any) {
		this.logger?.errorSync(
			'Key exchange failed',
			error instanceof Error ? error : new Error(String(error)),
			{
					operation: 'exchangeKeys',
				}
			);
			throw new Error(`Failed to exchange keys: ${error.message}`);
		}
	}

	/**
	 * Check if agent already exists and try key exchange
	 * GET /api/${API_VERSION}/device/:uuid
	 */
	async fetchAgent(apiEndpoint: string, uuid: string, apiKey: string): Promise<any> {
		const url = buildApiEndpoint(apiEndpoint, `/devices/${uuid}`);
		
		try {
			const response = await this.httpClient.get(url, {
				headers: this.createAuthHeaders(apiKey),
			});

			if (!response.ok) {
				if (response.status === 404) {
					return null; // Agent not found
				}
				const errorText = await response.json().catch(() => ({ message: response.statusText }));
				throw new Error(`API returned ${response.status}: ${JSON.stringify(errorText)}`);
			}

			return await response.json();
		} catch (error: any) {
			this.logger?.errorSync(
				'Failed to fetch agent 	info from API',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agentManager,
					operation: 'fetchAgent',
				}
			);
			return null;
		}
	}

	/**
	 * Update agent name
	 */
	async updateAgentName(name: string): Promise<void> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		this.agentInfo.name = name;
		await this.saveAgentInfo();
	}

	/**
	 * Update API endpoint
	 */
	async updateAPIEndpoint(endpoint: string): Promise<void> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		this.agentInfo.apiEndpoint = endpoint;
		await this.saveAgentInfo();
	}

	/**
	 * Update agent version
	 */
	async updateAgentVersion(version: string): Promise<void> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		this.agentInfo.agentVersion = version;
		await this.saveAgentInfo();
	}

	/**
	 * Reset agent (unprovision)
	 * Useful for testing or re-provisioning
	 * Keeps UUID and apiKey, clears server registration and MQTT credentials
	 */
	async reset(): Promise<void> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		// Clear server-assigned values
		this.agentInfo.name = undefined;
		this.agentInfo.provisioningApiKey = undefined;
		this.agentInfo.apiKey = undefined;
		this.agentInfo.apiEndpoint = undefined;
		this.agentInfo.registeredAt = undefined;
		this.agentInfo.provisioned = false;
		this.agentInfo.provisioningState = 'new';
		this.agentInfo.applicationId = undefined;
		
		// Clear MQTT credentials (these are cloud-assigned)
		this.agentInfo.mqttBrokerConfig = undefined;

		await this.saveAgentInfo();

		this.logger?.infoSync('Agent reset (unprovisioned)', {
			component: LogComponents.agentManager,
			operation: 'reset',
			note: 'UUID and deviceApiKey preserved for re-registration. MQTT credentials cleared.',
		});
	}
	
	/**
	 * Factory reset - complete cleanup of all agent data
	 * WARNING: This will delete all apps, services, state snapshots, and sensor data
	 * Only UUID will be preserved for hardware identification
	 */
	async factoryReset(): Promise<void> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		this.logger?.warnSync('Performing factory reset - all data will be deleted', {
			component: LogComponents.agentManager,
			operation: 'factoryReset',
		});

		// First, deprovision from cloud if agent is provisioned
		// This notifies the cloud API so the agent can be re-provisioned later
		if (this.agentInfo.provisioned && this.agentInfo.apiEndpoint) {
			try {
				this.logger?.infoSync('Deprovisioning from cloud before factory reset', {
					component: LogComponents.agentManager,
					operation: 'factoryReset',
					apiEndpoint: this.agentInfo.apiEndpoint,
				});
				
				const url = buildApiEndpoint(this.agentInfo.apiEndpoint, `/devices/${this.agentInfo.uuid}`);
				const response = await this.httpClient.get(url, {
					headers: this.createAuthHeaders(this.agentInfo.apiKey!),
				});

				if (!response.ok) {
					this.logger?.warnSync('Cloud deprovision failed, continuing with local reset', {
						component: LogComponents.agentManager,
						operation: 'factoryReset',
						status: response.status,
						note: 'Agent will be reset locally. Cloud may still think agent is provisioned.',
					});
				} else {
					this.logger?.infoSync('Cloud deprovision successful', {
						component: LogComponents.agentManager,
						operation: 'factoryReset',
					});
				}
			} catch (error: any) {
				this.logger?.warnSync('Cloud deprovision error, continuing with local reset', {
					component: LogComponents.agentManager,
					operation: 'factoryReset',
					error: error.message,
					note: 'Agent will be reset locally. Cloud may still think agent is provisioned.',
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
		
		// Reset agent info but preserve UUID for hardware identification
		const preservedUuid = this.agentInfo.uuid;
		
		this.agentInfo.name = undefined;
		this.agentInfo.type = undefined;
		this.agentInfo.apiKey = undefined; // Also clear API key for full reset
		this.agentInfo.provisioningApiKey = undefined;
		this.agentInfo.apiKey = undefined;
		this.agentInfo.apiEndpoint = undefined;
		this.agentInfo.registeredAt = undefined;
		this.agentInfo.provisioned = false;
		this.agentInfo.provisioningState = 'new';
		this.agentInfo.applicationId = undefined;
		this.agentInfo.macAddress = undefined;
		this.agentInfo.osVersion = undefined;
		this.agentInfo.agentVersion = undefined;
		this.agentInfo.mqttBrokerConfig = undefined;
		this.agentInfo.uuid = preservedUuid; // Restore UUID

		await this.saveAgentInfo();

		this.logger?.warnSync('Factory reset complete - agent returned to initial state', {
			component: LogComponents.agentManager,
			operation: 'factoryReset',
			uuid: preservedUuid,
			note: 'Only UUID preserved. All apps, services, and data deleted. Agent can be re-provisioned.',
		});
	}
}

export default AgentManager;




