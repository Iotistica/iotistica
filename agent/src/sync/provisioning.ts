import type {
	AgentInfo,
	KeyExchangeRequest,
	ProvisionRequest,
	ProvisionResponse,
	ProvisioningConfig,
} from '../core/types';
import { buildApiEndpoint } from '../utils/api-utils';
import { generateAPIKey, getAPIKeyFingerprint, parseAPIKey } from '../utils/crypto';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { HttpClient } from '../lib/http-client.js';
import type { PopCryptoManager } from '../security/pop-crypto.js';

type RetryWithBackoff = <T>(
	operation: () => Promise<T>,
	operationName: string,
	timeout?: number
) => Promise<T>;

type ProvisioningHooks = {
	saveAgentInfo: () => Promise<void>;
	setTenantIdCache: (tenantId: string) => Promise<void>;
	setupVpn: (agentInfo: AgentInfo, vpn: ProvisionResponse['vpn']) => Promise<void>;
	getAgentInfo: () => AgentInfo;
};

export class ProvisioningService {
	constructor(
		private readonly logger: AgentLogger | undefined,
		private readonly httpClient: HttpClient,
		private readonly popCryptoProvider: () => PopCryptoManager | undefined,
		private readonly retryWithBackoff: RetryWithBackoff,
	) {}

	async provision(
		agentInfo: AgentInfo,
		config: ProvisioningConfig,
		hooks: ProvisioningHooks,
	): Promise<AgentInfo> {
		if (!config.provisioningApiKey) {
			throw new Error('provisioningApiKey is required for agent provisioning');
		}

		if (!agentInfo.apiKey) {
			agentInfo.apiKey = generateAPIKey('v2');
			const keyMetadata = parseAPIKey(agentInfo.apiKey);
			this.logger?.infoSync('Generated new API key for provisioning', {
				component: LogComponents.agentManager,
				operation: 'provision',
				keyVersion: keyMetadata?.version,
				keyId: keyMetadata?.kid,
				keyFingerprint: getAPIKeyFingerprint(agentInfo.apiKey),
			});
		}

		agentInfo.name = config.name || agentInfo.name || `agent-${agentInfo.uuid.slice(0, 8)}`;
		agentInfo.type = config.type || agentInfo.type || 'generic';
		agentInfo.apiEndpoint = config.apiEndpoint || agentInfo.apiEndpoint;
		agentInfo.provisioningApiKey = config.provisioningApiKey;
		agentInfo.applicationId = config.applicationId;
		agentInfo.macAddress = config.macAddress;
		agentInfo.osVersion = config.osVersion;
		agentInfo.agentVersion = config.agentVersion;

		if (config.uuid && config.uuid !== agentInfo.uuid) {
			const currentState = agentInfo.provisioningState || 'new';
			const isRegistered = currentState !== 'new' && currentState !== 'registering';

			if (isRegistered) {
				this.logger?.errorSync(
					'Attempt to change UUID after cloud registration (rejected)',
					new Error('UUID is immutable after provisioning'),
					{
						component: LogComponents.agentManager,
						operation: 'provision',
						currentUuid: agentInfo.uuid,
						attemptedUuid: config.uuid,
						provisioningState: currentState,
					}
				);
				throw new Error(
					`UUID cannot be changed after cloud registration. ` +
						`Current UUID: ${agentInfo.uuid}, ` +
						`Attempted UUID: ${config.uuid}. ` +
						`Use factory reset to re-provision with a new UUID.`
				);
			}

			this.logger?.warnSync('Changing agent UUID before registration', {
				component: LogComponents.agentManager,
				operation: 'provision',
				oldUuid: agentInfo.uuid,
				newUuid: config.uuid,
				note: 'UUID override allowed only before cloud registration',
			});
			agentInfo.uuid = config.uuid;
		}

		try {
			const currentState = agentInfo.provisioningState || 'new';

			if (currentState !== 'new' && currentState !== 'provisioned') {
				this.logger?.warnSync('Resuming incomplete provisioning', {
					component: LogComponents.agentManager,
					operation: 'provision',
					currentState,
					note: 'Previous provisioning attempt failed mid-flight - resuming from last checkpoint',
				});
			}

			let response: ProvisionResponse | undefined;

			if (currentState === 'new' || currentState === 'registering') {
				this.logger?.infoSync('Phase 1: Registering agent with provisioning key', {
					component: LogComponents.agentManager,
					operation: 'provision',
					state: 'registering',
				});

				agentInfo.provisioningState = 'registering';
				await hooks.saveAgentInfo();

				const apiEndpoint = agentInfo.apiEndpoint || 'http://localhost:3002';
				const agentPublicKey = this.popCryptoProvider()?.getPublicKey();

				if (agentPublicKey) {
					this.logger?.infoSync('Registering with PoP public key', {
						component: LogComponents.agentManager,
						operation: 'provision',
						keyFingerprint: this.popCryptoProvider()?.getKeyFingerprint()
					});
				} else {
					this.logger?.warnSync('⚠️ Registering without PoP (using legacy bcrypt)', {
						component: LogComponents.agentManager,
						operation: 'provision',
						reason: 'PoP crypto not initialized'
					});
				}

				response = await this.retryWithBackoff(
					() => this.registerWithAPI(
						agentInfo,
						apiEndpoint,
						{
							uuid: agentInfo.uuid,
							deviceName: agentInfo.name!,
							deviceType: agentInfo.type!,
							deviceApiKey: agentInfo.apiKey!,
							devicePublicKey: agentPublicKey,
							applicationId: agentInfo.applicationId,
							macAddress: agentInfo.macAddress,
							osVersion: agentInfo.osVersion,
							agentVersion: agentInfo.agentVersion,
						},
						agentInfo.provisioningApiKey!,
					),
					'Agent Registration',
				);

				agentInfo.tenantId = response.tenantId;
				agentInfo.mqttBrokerConfig = response.mqtt.brokerConfig;
				agentInfo.apiTlsConfig = response.api?.tlsConfig;

				if (response.tenantId) {
					await hooks.setTenantIdCache(response.tenantId);
				}

				if (response.name) {
					agentInfo.name = response.name;
				}
				if (response.type) {
					agentInfo.type = response.type;
				}

				const redactedBrokerConfig = response.mqtt?.brokerConfig
					? {
						...response.mqtt.brokerConfig,
						password: response.mqtt.brokerConfig.password ? '[REDACTED]' : response.mqtt.brokerConfig.password,
					}
					: undefined;

				this.logger?.infoSync('Provisioning response received', {
					component: LogComponents.agentManager,
					operation: 'provision',
					responseKeys: Object.keys(response),
					tenantId: response.tenantId,
					mqttKeys: Object.keys(response.mqtt || {}),
					brokerConfigKeys: Object.keys(response.mqtt?.brokerConfig || {}),
					brokerConfig: redactedBrokerConfig,
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
					uuid: agentInfo.uuid,
				});
			} else {
				this.logger?.infoSync('Skipping registration (already registered)', {
					component: LogComponents.agentManager,
					operation: 'provision',
					state: currentState,
					uuid: agentInfo.uuid,
				});
			}

			if (currentState !== 'provisioned') {
				this.logger?.infoSync('Phase 2: Exchanging keys', {
					component: LogComponents.agentManager,
					operation: 'provision',
					state: 'key-exchanging',
				});

				agentInfo.provisioningState = 'key-exchanging';
				await hooks.saveAgentInfo();

				const apiEndpoint = agentInfo.apiEndpoint || 'http://localhost:3002';
				const challenge = response?.challenge;

				await this.retryWithBackoff(
					() => this.exchangeKeys(apiEndpoint, agentInfo.uuid, agentInfo.apiKey!, challenge),
					'Key Exchange',
				);

				this.logger?.infoSync('Phase 2 complete: Key exchange successful', {
					component: LogComponents.agentManager,
					operation: 'provision',
				});
			}

			this.logger?.infoSync('Phase 3: Removing provisioning key', {
				component: LogComponents.agentManager,
				operation: 'provision',
			});
			agentInfo.provisioningApiKey = undefined;
			agentInfo.provisioned = true;
			agentInfo.provisioningState = 'provisioned';
			agentInfo.registeredAt = Date.now();

			const vpnConfig = response?.vpn;
			agentInfo.vpnEnabled = !!(vpnConfig?.enabled);

			await hooks.saveAgentInfo();

			this.logger?.infoSync('Agent provisioned successfully', {
				component: LogComponents.agentManager,
				operation: 'provision',
				state: 'provisioned',
				uuid: agentInfo.uuid,
				agentName: agentInfo.name,
				applicationId: agentInfo.applicationId,
				mqttBrokerHost: agentInfo.mqttBrokerConfig?.host,
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

			await hooks.setupVpn(agentInfo, vpnConfig);
			return hooks.getAgentInfo();
		} catch (error: any) {
			const currentState = agentInfo.provisioningState;
			if (currentState === 'registering') {
				agentInfo.provisioningState = 'new';
				await hooks.saveAgentInfo();
			} else if (currentState === 'key-exchanging') {
				agentInfo.provisioningState = 'registered';
				await hooks.saveAgentInfo();
			}

			this.logger?.errorSync(
				'Provisioning failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agentManager,
					operation: 'provision',
					state: currentState,
					resetTo: agentInfo.provisioningState,
					note: 'State reset for idempotent retry',
				}
			);
			throw error;
		}
	}

	async exchangeKeys(
		apiEndpoint: string,
		uuid: string,
		deviceApiKey: string,
		challenge?: string
	): Promise<void> {
		const url = buildApiEndpoint(apiEndpoint, `/device/${uuid}/key-exchange`);
		const idempotencyKey = `key-exchange-${uuid}`;
		const popCrypto = this.popCryptoProvider();

		if (!challenge) {
			throw new Error('Server did not provide challenge - PoP authentication required');
		}

		if (!popCrypto?.isEnabled()) {
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
			const signature = popCrypto.signChallenge(challenge, uuid);
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
				keyFingerprint: popCrypto.getKeyFingerprint()
			});

			const response = await this.httpClient.post(url, requestBody, { headers });

			if (!response.ok) {
				const errorText = await response.json().catch(() => ({ message: response.statusText }));
				throw new Error(`Key exchange failed ${response.status}: ${JSON.stringify(errorText)}`);
			}

			await response.json();
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

	async fetchAgent(apiEndpoint: string, uuid: string, apiKey: string): Promise<unknown> {
		const url = buildApiEndpoint(apiEndpoint, `/devices/${uuid}`);

		try {
			const response = await this.httpClient.get(url, {
				headers: this.createAuthHeaders(apiKey),
			});

			if (!response.ok) {
				if (response.status === 404) {
					return null;
				}
				const errorText = await response.json().catch(() => ({ message: response.statusText }));
				throw new Error(`API returned ${response.status}: ${JSON.stringify(errorText)}`);
			}

			return await response.json();
		} catch (error: any) {
			this.logger?.errorSync(
				'Failed to fetch agent \tinfo from API',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agentManager,
					operation: 'fetchAgent',
				}
			);
			return null;
		}
	}

	private async registerWithAPI(
		agentInfo: AgentInfo,
		apiEndpoint: string,
		provisionRequest: ProvisionRequest,
		provisioningApiKey: string
	): Promise<ProvisionResponse> {
		const url = buildApiEndpoint(apiEndpoint, '/agent/register');
		const idempotencyKey = `register-${agentInfo.uuid}`;

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

			return await response.json();
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

	private createAuthHeaders(apiKey: string): Record<string, string> {
		return {
			Authorization: `Bearer ${apiKey}`,
		};
	}

	private createProvisioningHeaders(provisioningKey: string): Record<string, string> {
		return {
			'x-provisioning-key': provisioningKey,
		};
	}

	private createAgentKeyHeaders(agentKey: string): Record<string, string> {
		return {
			'x-agent-key': agentKey,
		};
	}
}
