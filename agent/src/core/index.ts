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
	ProvisionResponse
} from './types';
import { AgentModel } from '../db/models/agent.model';
import { PublishDestinationsModel } from '../db/models/publish-destinations.model';
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
import { ProvisioningService } from '../sync/provisioning.js';

export class AgentManager {
	private agentInfo: AgentInfo | null = null;
	private logger?: AgentLogger;
	private httpClient: HttpClient;
	private dbClient: DatabaseClient;
	private uuidGenerator: UuidGenerator;
	private popCrypto?: PopCryptoManager;
	private provisioningService: ProvisioningService;

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
		this.provisioningService = new ProvisioningService(
			this.logger,
			this.httpClient,
			() => this.popCrypto,
			(operation, operationName, timeout) => this.retryWithBackoff(operation, operationName, timeout),
		);
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
		
		AgentModel.initializeEncryption(dataDir, this.logger);
		PublishDestinationsModel.initializeEncryption(dataDir, this.logger);

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
				// null/undefined in DB means existing record before migration → default true (full sync)
				targetSyncEnabled: record.targetSyncEnabled == null ? true : !!record.targetSyncEnabled,
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
			targetSyncEnabled: this.agentInfo.targetSyncEnabled ?? true,
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

	async setTargetSyncEnabled(enabled: boolean): Promise<void> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}
		this.agentInfo.targetSyncEnabled = enabled;
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
	* Mark agent as running in local mode (no cloud provisioning needed)
	*/
	async markAsLocalMode(): Promise<void> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		this.agentInfo.provisioned = false;
		this.agentInfo.provisioningState = 'new';
		this.agentInfo.name = this.agentInfo.name || `agent-${this.agentInfo.uuid.slice(0, 8)}`;
		this.agentInfo.type = this.agentInfo.type || 'standalone';
		this.agentInfo.agentVersion = process.env.AGENT_VERSION || getPackageVersion();
		this.agentInfo.mqttBrokerConfig = undefined;

		await this.saveAgentInfo();

		this.logger?.infoSync('Agent configured for local mode', {
			component: LogComponents.agentManager,
			operation: 'markAsLocalMode',
			uuid: this.agentInfo.uuid,
			agentName: this.agentInfo.name,
			agentVersion: this.agentInfo.agentVersion,
		});
	}

	async provision(config: ProvisioningConfig): Promise<AgentInfo> {
		if (!this.agentInfo) {
			throw new Error('Agent manager not initialized');
		}

		return this.provisioningService.provision(this.agentInfo, config, {
			saveAgentInfo: async () => {
				// Newly provisioned agents start in report-only mode.
				// The operator enables target-state pull from the admin UI once
				// the cloud target has been configured.
				this.agentInfo!.targetSyncEnabled = false;
				return this.saveAgentInfo();
			},
			setTenantIdCache: async (tenantId: string) => {
				const { setTenantId } = await import('../mqtt/topics.js');
				setTenantId(tenantId);
			},
			setupVpn: (agentInfo: AgentInfo, vpn: ProvisionResponse['vpn']) =>
				this.setupVpnFromProvisioning(agentInfo, vpn),
			getAgentInfo: () => this.getAgentInfo(),
		});
	}

	async exchangeKeys(
		apiEndpoint: string,
		uuid: string,
		deviceApiKey: string,
		challenge?: string
	): Promise<void> {
		return this.provisioningService.exchangeKeys(apiEndpoint, uuid, deviceApiKey, challenge);
	}

	async fetchAgent(apiEndpoint: string, uuid: string, apiKey: string): Promise<any> {
		return this.provisioningService.fetchAgent(apiEndpoint, uuid, apiKey);
	}

	private async setupVpnFromProvisioning(
		agentInfo: AgentInfo,
		vpnConfig: ProvisionResponse['vpn'],
	): Promise<void> {
		if (!vpnConfig?.enabled || vpnConfig.type !== 'tailscale') {
			return;
		}

		this.logger?.infoSync('Setting up Tailscale VPN', {
			component: LogComponents.agentManager,
			operation: 'provision',
			tailnetName: vpnConfig.tailscale.tailnetName,
		});

		try {
			const { TailscaleManager } = await import('../network/vpn/tailscale-manager.js');
			const tailscaleManager = new TailscaleManager(this.logger);

			const isInstalled = await tailscaleManager.checkInstallation();
			if (!isInstalled) {
				await tailscaleManager.install();
			}

			await tailscaleManager.configure({
				authKey: vpnConfig.tailscale.authKey,
				tailnetName: vpnConfig.tailscale.tailnetName,
				hostname: agentInfo.name,
				shieldsUp: vpnConfig.tailscale.shieldsUp ?? true,
				acceptRoutes: vpnConfig.tailscale.acceptRoutes ?? false,
				acceptDNS: vpnConfig.tailscale.acceptDNS ?? false,
			});

			const tailscaleIP = await tailscaleManager.getIP();

			this.logger?.infoSync('Tailscale VPN tunnel established successfully', {
				component: LogComponents.agentManager,
				operation: 'provision',
				tailscaleIP,
				tailnetName: vpnConfig.tailscale.tailnetName,
			});
		} catch (vpnError) {
			this.logger?.warnSync('Tailscale VPN setup failed (agent will continue without VPN)', {
				component: LogComponents.agentManager,
				operation: 'provision',
				error: vpnError instanceof Error ? vpnError.message : String(vpnError),
			});
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
	* WARNING: This will delete all apps, services, state snapshots, and device data
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


export type { AgentInfo, ProvisioningConfig, ProvisionRequest, ProvisionResponse } from './types.js';
