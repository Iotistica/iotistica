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
	ProvisionResponse 
} from './types';
import { buildApiEndpoint, getPackageVersion } from '../utils/api-utils';
import { DefaultUuidGenerator, generateAPIKey, type UuidGenerator } from '../utils/crypto';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { HttpClient, FetchHttpClient } from '../lib/http-client';
import { DatabaseClient, KnexDatabaseClient } from '../db/client';
import { WireGuardManager } from '../network/vpn/wireguard-manager';

export class DeviceManager {
	private deviceInfo: DeviceInfo | null = null;
	private logger?: AgentLogger;
	private httpClient: HttpClient;
	private dbClient: DatabaseClient;
	private uuidGenerator: UuidGenerator;

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
	 * Initialize device manager and load device info from database
	 */
	async initialize(): Promise<void> {
		await this.loadDeviceInfo();

		if (!this.deviceInfo) {
			// Create new device with generated UUID and deviceApiKey
			this.deviceInfo = {
				uuid: this.uuidGenerator.generate(),
				deviceApiKey: generateAPIKey(), // Pre-generate device key
				provisioned: false,
				agentVersion: process.env.AGENT_VERSION || getPackageVersion(), // Set version on creation
			};
			await this.saveDeviceInfo();
			this.logger?.infoSync('New device created', {
				component: LogComponents.deviceManager,
				operation: 'initialize',
				uuid: this.deviceInfo.uuid,
				deviceApiKeyPreview: `${this.deviceInfo.deviceApiKey?.substring(0, 8)}...`,
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
			
			this.logger?.infoSync('Device loaded', {
				component: LogComponents.deviceManager,
				operation: 'initialize',
				uuid: this.deviceInfo.uuid,
				deviceId: this.deviceInfo.deviceId,
				provisioned: this.deviceInfo.provisioned,
				hasDeviceApiKey: !!this.deviceInfo.deviceApiKey,
				deviceApiKeyPrefix: this.deviceInfo.deviceApiKey?.substring(0, 16) || 'none',
				hasApiKey: !!this.deviceInfo.apiKey,
				apiKeyPrefix: this.deviceInfo.apiKey?.substring(0, 16) || 'none',
				hasProvisioningKey: !!this.deviceInfo.provisioningApiKey,
				agentVersion: this.deviceInfo.agentVersion, // Add version to log
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
				applicationId: record.applicationId || undefined,
				macAddress: record.macAddress || undefined,
				osVersion: record.osVersion || undefined,
			agentVersion: record.agentVersion || undefined,
			mqttUsername: record.mqttUsername || undefined,
			mqttPassword: record.mqttPassword || undefined,
			mqttBrokerUrl: record.mqttBrokerUrl || undefined,
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
}	/**
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
			applicationId: this.deviceInfo.applicationId || null,
			macAddress: this.deviceInfo.macAddress || null,
			osVersion: this.deviceInfo.osVersion || null,
			agentVersion: this.deviceInfo.agentVersion || null,
		mqttUsername: this.deviceInfo.mqttUsername || null,
		mqttPassword: this.deviceInfo.mqttPassword || null,
		mqttBrokerUrl: this.deviceInfo.mqttBrokerUrl || null,
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

		// Ensure device API key exists
		if (!this.deviceInfo.deviceApiKey) {
			this.deviceInfo.deviceApiKey = generateAPIKey();
		}

			// Update device metadata
		this.deviceInfo.deviceName = config.deviceName || this.deviceInfo.deviceName || `device-${this.deviceInfo.uuid.slice(0, 8)}`;
		this.deviceInfo.deviceType = config.deviceType || this.deviceInfo.deviceType || 'generic';
		this.deviceInfo.apiEndpoint = config.apiEndpoint || this.deviceInfo.apiEndpoint;
		this.deviceInfo.provisioningApiKey = config.provisioningApiKey;
		this.deviceInfo.macAddress = config.macAddress;
		this.deviceInfo.osVersion = config.osVersion;
		this.deviceInfo.agentVersion = config.agentVersion;		// If UUID is provided in config, use it (useful for pre-configured devices)
			if (config.uuid && config.uuid !== this.deviceInfo.uuid) {
				this.deviceInfo.uuid = config.uuid;
			}

		try {
			// Phase 1: Register device with cloud API
			this.logger?.infoSync('Phase 1: Registering device with provisioning key', {
				component: LogComponents.deviceManager,
				operation: 'provision',
				uuid: this.deviceInfo.uuid,
				deviceName: this.deviceInfo.deviceName,
				deviceType: this.deviceInfo.deviceType,
				hasDeviceApiKey: !!this.deviceInfo.deviceApiKey,
				hasProvisioningApiKey: !!this.deviceInfo.provisioningApiKey,
			});
			const response = await this.registerWithAPI(
				this.deviceInfo.apiEndpoint || 'http://localhost:3002',
				{
				uuid: this.deviceInfo.uuid,
				deviceName: this.deviceInfo.deviceName!,
				deviceType: this.deviceInfo.deviceType!,
				deviceApiKey: this.deviceInfo.deviceApiKey!,
				macAddress: this.deviceInfo.macAddress,
				osVersion: this.deviceInfo.osVersion,
				agentVersion: this.deviceInfo.agentVersion,
			},
				this.deviceInfo.provisioningApiKey!
		);

		// Save server-assigned device ID
		this.deviceInfo.deviceId = response.id.toString();
		this.deviceInfo.mqttUsername = response.mqtt.username;
		this.deviceInfo.mqttPassword = response.mqtt.password;
		this.deviceInfo.mqttBrokerUrl = response.mqtt.broker;
		this.deviceInfo.mqttBrokerConfig = response.mqtt.brokerConfig; // Save TLS config if provided
		this.deviceInfo.apiTlsConfig = response.api?.tlsConfig; // Save API HTTPS TLS config if provided

		// Phase 2: Exchange keys - verify device can authenticate with deviceApiKey
			this.logger?.debugSync('Phase 2: Exchanging keys', {
				component: LogComponents.deviceManager,
				operation: 'provision',
			});
			await this.exchangeKeys(
				this.deviceInfo.apiEndpoint || 'http://localhost:3002',
				this.deviceInfo.uuid,
				this.deviceInfo.deviceApiKey
			);

			// Phase 3: Remove provisioning key (one-time use complete)
			this.logger?.infoSync('Phase 3: Removing provisioning key', {
				component: LogComponents.deviceManager,
				operation: 'provision',
			});
			this.deviceInfo.provisioningApiKey = undefined;

			// Mark as provisioned
			this.deviceInfo.provisioned = true;
			this.deviceInfo.registeredAt = Date.now();

			// Save to database
			await this.saveDeviceInfo();

			this.logger?.infoSync('Device provisioned successfully', {
				component: LogComponents.deviceManager,
				operation: 'provision',
				uuid: this.deviceInfo.uuid,
				deviceId: this.deviceInfo.deviceId,
				deviceName: this.deviceInfo.deviceName,
				mqttUsername: this.deviceInfo.mqttUsername,
				mqttBrokerUrl: this.deviceInfo.mqttBrokerUrl,
				mqttBrokerConfig: this.deviceInfo.mqttBrokerConfig,
			});

			// Phase 4: Setup VPN if provided in response
			if (response.vpnConfig?.enabled) {
				this.logger?.infoSync('Setting up WireGuard VPN', {
					component: LogComponents.deviceManager,
					operation: 'provision',
					vpnIpAddress: response.vpnConfig.ipAddress,
				});

				try {
					const vpnManager = new WireGuardManager('wg0', '/etc/wireguard', this.logger);
					const vpnSetupSuccess = await vpnManager.setup(response.vpnConfig);

					if (vpnSetupSuccess) {
						this.logger?.infoSync('VPN tunnel established successfully', {
							component: LogComponents.deviceManager,
							operation: 'provision',
							vpnIpAddress: response.vpnConfig.ipAddress,
						});
					} else {
						this.logger?.warnSync('VPN setup was skipped or failed (non-critical)', {
							component: LogComponents.deviceManager,
							operation: 'provision',
						});
					}
				} catch (vpnError) {
					// VPN setup failure is non-critical - device can still operate
					this.logger?.warnSync('VPN setup failed (device will continue without VPN)', {
						component: LogComponents.deviceManager,
						operation: 'provision',
						error: vpnError instanceof Error ? vpnError.message : String(vpnError),
					});
				}
			}

			return this.getDeviceInfo();
		} catch (error: any) {
			this.logger?.errorSync(
				'Provisioning failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.deviceManager,
					operation: 'provision',
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
		
		this.logger?.infoSync('Registering device with API', {
			component: LogComponents.deviceManager,
			operation: 'registerWithAPI',
			url,
			uuid: provisionRequest.uuid,
			deviceName: provisionRequest.deviceName,
			deviceType: provisionRequest.deviceType,
		});

		try {
			const response = await this.httpClient.post<ProvisionResponse>(url, provisionRequest, {
				headers: this.createAuthHeaders(provisioningApiKey),
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
	 */
	async exchangeKeys(apiEndpoint: string, uuid: string, deviceApiKey: string): Promise<void> {
		const url = buildApiEndpoint(apiEndpoint, `/device/${uuid}/key-exchange`);
		
		this.logger?.infoSync('Exchanging keys for device', {
			component: LogComponents.deviceManager,
			operation: 'exchangeKeys',
			uuid,
		});

		try {
			const response = await this.httpClient.post(url, {
				uuid,
				deviceApiKey,
			}, {
				headers: this.createAuthHeaders(deviceApiKey),
			});

			if (!response.ok) {
				const errorText = await response.json().catch(() => ({ message: response.statusText }));
				throw new Error(`Key exchange failed ${response.status}: ${JSON.stringify(errorText)}`);
			}

			const result = await response.json();
			this.logger?.infoSync('Key exchange successful', {
				component: LogComponents.deviceManager,
				operation: 'exchangeKeys',
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
		
		// Clear MQTT credentials (these are cloud-assigned)
		this.deviceInfo.mqttUsername = undefined;
		this.deviceInfo.mqttPassword = undefined;
		this.deviceInfo.mqttBrokerUrl = undefined;

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

		// Import db connection
		const { models } = await import('../db/connection.js');
		
		// Helper to safely delete from table (ignore if table doesn't exist)
		const safeDelete = async (tableName: string) => {
			try {
				await models(tableName).delete();
				this.logger?.infoSync(`Deleted ${tableName}`, {
					component: LogComponents.deviceManager,
					operation: 'factoryReset',
				});
			} catch (error: any) {
				// Table doesn't exist or is empty - this is fine
				this.logger?.debugSync(`Table ${tableName} not found or already empty`, {
					component: LogComponents.deviceManager,
					operation: 'factoryReset',
					error: error.message,
				});
			}
		};
		
		// Delete all data tables (ignore if they don't exist)
		await safeDelete('stateSnapshot');
		await safeDelete('service');
		await safeDelete('app');
		await safeDelete('image');
		await safeDelete('endpoint_outputs');
		await safeDelete('sensors');
		
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
		this.deviceInfo.macAddress = undefined;
		this.deviceInfo.osVersion = undefined;
		this.deviceInfo.agentVersion = undefined;
		this.deviceInfo.mqttUsername = undefined;
		this.deviceInfo.mqttPassword = undefined;
		this.deviceInfo.mqttBrokerUrl = undefined;
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
