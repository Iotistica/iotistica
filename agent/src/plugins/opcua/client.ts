import { createHash } from 'crypto';
import {
	AttributeIds,
	type ClientMonitoredItem,
	type ClientSession,
	type ClientSubscription,
	DataType,
	type DataValue,
	MessageSecurityMode,
	type OPCUAClient,
	OPCUAClient as OPCUAClientFactory,
	type ReadValueIdOptions,
	SecurityPolicy,
	type StatusCode,
	UserTokenType,
	Variant,
} from 'node-opcua-client';
import {
	type IProtocolClient,
	type Logger,
} from '../types.js';
import {
	type OPCUAConnection,
	type OPCUADeviceConfig,
	type OPCUADataPoint,
	type OPCUASecurityMode,
	type OPCUASecurityPolicy,
	type OPCUACertificateTrustMode,
} from './types.js';

/**
 * OPC-UA client session state for a single device.
 *
 * Kept in a dedicated module so OPC-UA follows the same file structure as
 * Modbus/BACnet (adapter + client).
 */
export interface OPCUASession {
	client: OPCUAClient;
	session: ClientSession | null;
	subscription: ClientSubscription | null;
	subscriptions: ClientSubscription[];
	monitoredItems: Map<string, ClientMonitoredItem>;
	validatedNodes: Set<string>;
	reconnecting: boolean;
	reconnectTimer?: NodeJS.Timeout;
	currentRetryDelay: number;
	consecutiveFailures: number;
}

/**
 * Build a fresh OPC-UA session wrapper with standard defaults.
 */
export function createOPCUASession(
	client: OPCUAClient,
	session: ClientSession,
	initialRetryDelay: number
): OPCUASession {
	return {
		client,
		session,
		subscription: null,
		subscriptions: [],
		monitoredItems: new Map(),
		validatedNodes: new Set(),
		reconnecting: false,
		currentRetryDelay: initialRetryDelay,
		consecutiveFailures: 0,
	};
}

export interface OPCUADeviceClientOptions {
	minRetryDelay?: number;
	maxReadRetries?: number;
	readRetryDelayMs?: number;
}

/**
 * Protocol runtime client for a single OPC-UA device.
 *
 * It encapsulates endpoint discovery, secure connection/session setup,
 * request serialization, and transient read retries.
 */
export class OPCUADeviceClient
implements IProtocolClient<ReadValueIdOptions[], DataValue[]>
{
	private readonly device: OPCUADeviceConfig;
	private readonly logger: Logger;
	private readonly minRetryDelay: number;
	private readonly maxReadRetries: number;
	private readonly readRetryDelayMs: number;
	private sessionWrapper: OPCUASession | null = null;
	private queue: Promise<any> = Promise.resolve();

	constructor(
		device: OPCUADeviceConfig,
		logger: Logger,
		options: OPCUADeviceClientOptions = {}
	) {
		this.device = device;
		this.logger = logger;
		this.minRetryDelay = options.minRetryDelay ?? 5000;
		this.maxReadRetries = options.maxReadRetries ?? 3;
		this.readRetryDelayMs = options.readRetryDelayMs ?? 100;
	}

	getSessionWrapper(): OPCUASession | null {
		return this.sessionWrapper;
	}

	async connect(): Promise<void> {
		const { connection } = this.device;

		this.logger.debug(`Connecting to OPC-UA device: ${this.device.name}`);
		this.logger.debug(`Endpoint: ${connection.endpointUrl}`);

		const desiredSecurityMode = this.convertSecurityMode(connection.securityMode);
		const desiredSecurityPolicy = this.convertSecurityPolicy(connection.securityPolicy);

		const discoveredEndpoint = await this.discoverAndSelectEndpoint(
			connection.endpointUrl,
			desiredSecurityMode,
			desiredSecurityPolicy,
			connection,
			this.device.name
		);

		const client = OPCUAClientFactory.create(await this.createClientOptions(connection));

		try {
			const connectUrl = discoveredEndpoint?.endpointUrl || connection.endpointUrl;
			await client.connect(connectUrl);

			this.assertExpectedServerThumbprint(
				connection.expectedServerThumbprint,
				discoveredEndpoint?.serverCertificate || (client as any).serverCertificate,
				this.device.name,
				connectUrl
			);

			let session: ClientSession;
			if (connection.username && connection.password) {
				session = await client.createSession({
					type: UserTokenType.UserName,
					userName: connection.username,
					password: connection.password,
				});
			} else {
				session = await client.createSession();
			}

			this.sessionWrapper = createOPCUASession(client, session, this.minRetryDelay);
		} catch (error) {
			try {
				await client.disconnect();
			} catch {
				// Ignore cleanup errors when primary connect failed.
			}
			throw error;
		}
	}

	async disconnect(): Promise<void> {
		if (!this.sessionWrapper) {
			return;
		}

		await this.cleanup(true);
		this.sessionWrapper = null;
	}

	async cleanup(clearTimer: boolean = true): Promise<void> {
		const sessionWrapper = this.sessionWrapper;
		if (!sessionWrapper) {
			return;
		}

		if (clearTimer && sessionWrapper.reconnectTimer) {
			clearTimeout(sessionWrapper.reconnectTimer);
			sessionWrapper.reconnectTimer = undefined;
		}

		try {
			sessionWrapper.validatedNodes.clear();
			sessionWrapper.monitoredItems.clear();

			for (const subscription of sessionWrapper.subscriptions) {
				try {
					await subscription.terminate();
				} catch {
					// Ignore per-subscription errors during cleanup.
				}
			}
			sessionWrapper.subscriptions = [];

			if (sessionWrapper.subscription) {
				try {
					await sessionWrapper.subscription.terminate();
				} catch {
					// Ignore per-subscription errors during cleanup.
				}
				sessionWrapper.subscription = null;
			}

			if (sessionWrapper.session) {
				await sessionWrapper.session.close();
				sessionWrapper.session = null;
			}

			await sessionWrapper.client.disconnect();
		} catch (error) {
			this.logger.debug(`Error during OPC-UA client cleanup: ${error}`);
		}
	}

	isConnected(): boolean {
		return !!this.sessionWrapper?.session;
	}

	async read(nodesToRead: ReadValueIdOptions[] = []): Promise<DataValue[]> {
		const session = this.sessionWrapper?.session;
		if (!session) {
			throw new Error(`No active OPC-UA session for ${this.device.name}`);
		}

		if (nodesToRead.length === 0) {
			return [];
		}

		return this.lock(() => this.readWithRetry(session, nodesToRead));
	}

	async write(registerName: string, value: number | boolean | string): Promise<void> {
		const session = this.sessionWrapper?.session;
		if (!session) {
			throw new Error(`No active OPC-UA session for ${this.device.name}`);
		}

		const node = this.findWriteDataPoint(registerName);

		await this.lock(async () => {
			const prepared = this.prepareWriteValue(node, value);
			const statusCode = await session.write({
				nodeId: node.nodeId,
				attributeId: AttributeIds.Value,
				value: {
					value: new Variant({ dataType: prepared.dataType, value: prepared.value }),
				},
			});

			if (!this.isStatusGood(statusCode)) {
				const statusName = statusCode?.name || String(statusCode);
				throw new Error(`Write failed for ${node.nodeId}: ${statusName}`);
			}
		});
	}

	private findWriteDataPoint(target: string): OPCUADataPoint {
		const dataPoint = this.device.dataPoints.find((dp) => dp.name === target || dp.nodeId === target);
		if (!dataPoint) {
			throw new Error(`Node not found on device ${this.device.name}: ${target}`);
		}
		if (!dataPoint.writable) {
			throw new Error(`Node is not writable: ${dataPoint.name} (${dataPoint.nodeId})`);
		}
		return dataPoint;
	}

	private async lock<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		this.queue = result.catch(() => {});
		return result;
	}

	private isTransientError(statusCode: any): boolean {
		if (!statusCode) {
			return false;
		}

		const statusName = statusCode.name || statusCode.toString();
		const transientPatterns = [
			'BadOutOfRange',
			'BadNotConnected',
			'BadNoCommunication',
			'BadTimeout',
			'BadCommunicationError',
			'BadServerHalted',
			'BadDataUnavailable',
			'BadWaitingForInitialData',
		];

		return transientPatterns.some(pattern => statusName.includes(pattern));
	}

	private async readWithRetry(session: ClientSession, nodesToRead: ReadValueIdOptions[]): Promise<DataValue[]> {
		const results = await session.read(nodesToRead);

		for (let attempt = 1; attempt <= this.maxReadRetries; attempt++) {
			const failedIndices: number[] = [];
			results.forEach((dv: DataValue, idx: number) => {
				if (!dv.statusCode.isGood() && this.isTransientError(dv.statusCode)) {
					failedIndices.push(idx);
				}
			});

			if (failedIndices.length === 0 || attempt === this.maxReadRetries) {
				return results;
			}

			await new Promise(resolve => setTimeout(resolve, this.readRetryDelayMs));
			const retryNodes = failedIndices.map(idx => nodesToRead[idx]);
			const retryResults = await session.read(retryNodes);

			retryResults.forEach((dv: DataValue, retryIdx: number) => {
				const originalIdx = failedIndices[retryIdx];
				results[originalIdx] = dv;
			});
		}

		return results;
	}

	private isStatusGood(statusCode: StatusCode | undefined): boolean {
		return Boolean(statusCode && typeof statusCode.isGood === 'function' && statusCode.isGood());
	}

	private prepareWriteValue(node: OPCUADataPoint, value: number | boolean | string): { dataType: DataType; value: any } {
		const transformedValue = this.applyWriteScaling(node, value);
		const dataType = this.resolveWriteDataType(node, transformedValue);

		// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
		switch (dataType) {
			case DataType.Boolean:
				return { dataType, value: this.toBoolean(node.name, transformedValue) };
			case DataType.SByte:
				return { dataType, value: this.toIntegerInRange(node.name, transformedValue, -128, 127) };
			case DataType.Byte:
				return { dataType, value: this.toIntegerInRange(node.name, transformedValue, 0, 255) };
			case DataType.Int16:
				return { dataType, value: this.toIntegerInRange(node.name, transformedValue, -32768, 32767) };
			case DataType.UInt16:
				return { dataType, value: this.toIntegerInRange(node.name, transformedValue, 0, 65535) };
			case DataType.Int32:
				return { dataType, value: this.toIntegerInRange(node.name, transformedValue, -2147483648, 2147483647) };
			case DataType.UInt32:
				return { dataType, value: this.toIntegerInRange(node.name, transformedValue, 0, 4294967295) };
			case DataType.Int64:
				return { dataType, value: BigInt(this.toIntegerInRange(node.name, transformedValue, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) };
			case DataType.UInt64:
				return { dataType, value: BigInt(this.toIntegerInRange(node.name, transformedValue, 0, Number.MAX_SAFE_INTEGER)) };
			case DataType.Float:
				return { dataType, value: this.toNumber(node.name, transformedValue) };
			case DataType.Double:
				return { dataType, value: this.toNumber(node.name, transformedValue) };
			case DataType.String:
				return { dataType, value: String(transformedValue) };
			default:
				throw new Error(`Unsupported OPC UA write data type for ${node.name}`);
		}
	}

	private applyWriteScaling(node: OPCUADataPoint, value: number | boolean | string): number | boolean | string {
		if (typeof value !== 'number') {
			return value;
		}

		const scale = node.scalingFactor ?? 1;
		const offset = node.offset ?? 0;
		return (value - offset) / scale;
	}

	private resolveWriteDataType(node: OPCUADataPoint, value: number | boolean | string): DataType {
		// eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
		switch (node.writeDataType) {
			case 'Boolean': return DataType.Boolean;
			case 'SByte': return DataType.SByte;
			case 'Byte': return DataType.Byte;
			case 'Int16': return DataType.Int16;
			case 'UInt16': return DataType.UInt16;
			case 'Int32': return DataType.Int32;
			case 'UInt32': return DataType.UInt32;
			case 'Int64': return DataType.Int64;
			case 'UInt64': return DataType.UInt64;
			case 'Float': return DataType.Float;
			case 'Double': return DataType.Double;
			case 'String': return DataType.String;
			default:
				if (typeof value === 'boolean') return DataType.Boolean;
				if (typeof value === 'number') return Number.isInteger(value) ? DataType.Int32 : DataType.Double;
				return DataType.String;
		}
	}

	private toNumber(nodeName: string, value: number | boolean | string): number {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string') {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
		throw new Error(`Value for ${nodeName} must be a finite number`);
	}

	private toIntegerInRange(nodeName: string, value: number | boolean | string, min: number, max: number): number {
		const numeric = this.toNumber(nodeName, value);
		if (!Number.isInteger(numeric)) {
			throw new Error(`Value for ${nodeName} must be an integer`);
		}
		if (numeric < min || numeric > max) {
			throw new Error(`Value for ${nodeName} out of range (${min} to ${max})`);
		}
		return numeric;
	}

	private toBoolean(nodeName: string, value: number | boolean | string): boolean {
		if (typeof value === 'boolean') {
			return value;
		}
		if (typeof value === 'number') {
			if (value === 0) return false;
			if (value === 1) return true;
		}
		if (typeof value === 'string') {
			const normalized = value.trim().toLowerCase();
			if (normalized === 'true' || normalized === '1') return true;
			if (normalized === 'false' || normalized === '0') return false;
		}
		throw new Error(`Value for ${nodeName} must be boolean-like`);
	}

	private normalizeThumbprint(thumbprint: string): string {
		return thumbprint.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
	}

	private calculateCertificateThumbprint(certificate: Buffer): string {
		return createHash('sha1').update(certificate).digest('hex');
	}

	private async createCertificateManager(trustMode: OPCUACertificateTrustMode): Promise<any> {
		const { getDefaultCertificateManager } = await import('node-opcua-certificate-manager');
		const certificateManager = getDefaultCertificateManager('PKI');
		certificateManager.automaticallyAcceptUnknownCertificate = trustMode === 'trust-on-first-use';
		return certificateManager;
	}

	private async createClientOptions(connection: OPCUAConnection): Promise<Record<string, unknown>> {
		return {
			applicationName: 'Iotistica Agent',
			applicationUri: 'urn:iotistica:agent',
			connectionStrategy: {
				initialDelay: 1000,
				maxRetry: 3,
				maxDelay: connection.connectionTimeout || 10000,
			},
			securityMode: this.convertSecurityMode(connection.securityMode),
			securityPolicy: this.convertSecurityPolicy(connection.securityPolicy),
			endpointMustExist: false,
			keepSessionAlive: true,
			requestedSessionTimeout: connection.sessionTimeout || 60000,
			clientCertificateManager: await this.createCertificateManager(
				connection.certificateTrustMode || 'strict'
			),
		};
	}

	private assertExpectedServerThumbprint(
		expectedThumbprint: string | undefined,
		certificate: Buffer | undefined,
		deviceName: string,
		endpointUrl: string
	): void {
		if (!expectedThumbprint) {
			return;
		}

		if (!certificate) {
			throw new Error(
				`Device ${deviceName}: expected server certificate thumbprint is configured but endpoint ${endpointUrl} did not provide a certificate`
			);
		}

		const actualThumbprint = this.calculateCertificateThumbprint(certificate);
		const normalizedExpected = this.normalizeThumbprint(expectedThumbprint);

		if (actualThumbprint !== normalizedExpected) {
			throw new Error(
				`Device ${deviceName}: server certificate thumbprint mismatch for ${endpointUrl}. Expected ${normalizedExpected}, got ${actualThumbprint}`
			);
		}
	}

	private matchesSecurityPolicy(endpointPolicyUri: string | undefined, desiredPolicy: SecurityPolicy): boolean {
		if (!endpointPolicyUri) {
			return desiredPolicy === SecurityPolicy.None;
		}

		const policyMap: Record<string, SecurityPolicy> = {
			'http://opcfoundation.org/UA/SecurityPolicy#None': SecurityPolicy.None,
			'http://opcfoundation.org/UA/SecurityPolicy#Basic128Rsa15': SecurityPolicy.Basic128Rsa15,
			'http://opcfoundation.org/UA/SecurityPolicy#Basic256': SecurityPolicy.Basic256,
			'http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256': SecurityPolicy.Basic256Sha256,
			'http://opcfoundation.org/UA/SecurityPolicy#Aes128_Sha256_RsaOaep': SecurityPolicy.Aes128_Sha256_RsaOaep,
			'http://opcfoundation.org/UA/SecurityPolicy#Aes256_Sha256_RsaPss': SecurityPolicy.Aes256_Sha256_RsaPss,
		};

		return policyMap[endpointPolicyUri] === desiredPolicy;
	}

	private async discoverAndSelectEndpoint(
		baseUrl: string,
		desiredSecurityMode: MessageSecurityMode,
		desiredSecurityPolicy: SecurityPolicy,
		connection: OPCUAConnection,
		deviceName: string
	): Promise<any | null> {
		try {
			const discoveryClient = OPCUAClientFactory.create(await this.createClientOptions(connection));
			await discoveryClient.connect(baseUrl);
			const allEndpoints = await discoveryClient.getEndpoints();
			await discoveryClient.disconnect();

			if (!allEndpoints || allEndpoints.length === 0) {
				return null;
			}

			const matchingEndpoints = allEndpoints.filter((endpoint: any) => {
				const modeMatch = endpoint.securityMode === desiredSecurityMode;
				const policyMatch = this.matchesSecurityPolicy(endpoint.securityPolicyUri, desiredSecurityPolicy);
				const transportMatch = endpoint.transportProfileUri?.includes('http://opcfoundation.org/UA-Profile/Transport/uatcp-uasc-uabinary');

				return modeMatch && policyMatch && transportMatch;
			});

			if (matchingEndpoints.length === 0) {
				return null;
			}

			const bestEndpoint = matchingEndpoints[0];
			this.assertExpectedServerThumbprint(
				connection.expectedServerThumbprint,
				bestEndpoint.serverCertificate,
				deviceName,
				bestEndpoint.endpointUrl || baseUrl
			);

			return bestEndpoint;
		} catch (error) {
			this.logger.warn('Endpoint discovery failed', {
				error: error instanceof Error ? error.message : String(error)
			});
			return null;
		}
	}

	private convertSecurityMode(mode: OPCUASecurityMode): MessageSecurityMode {
		switch (mode) {
			case 'None':
				return MessageSecurityMode.None;
			case 'Sign':
				return MessageSecurityMode.Sign;
			case 'SignAndEncrypt':
				return MessageSecurityMode.SignAndEncrypt;
			default:
				return MessageSecurityMode.None;
		}
	}

	private convertSecurityPolicy(policy: OPCUASecurityPolicy): SecurityPolicy {
		switch (policy) {
			case 'None':
				return SecurityPolicy.None;
			case 'Basic128Rsa15':
				return SecurityPolicy.Basic128Rsa15;
			case 'Basic256':
				return SecurityPolicy.Basic256;
			case 'Basic256Sha256':
				return SecurityPolicy.Basic256Sha256;
			case 'Aes128_Sha256_RsaOaep':
				return SecurityPolicy.Aes128_Sha256_RsaOaep;
			case 'Aes256_Sha256_RsaPss':
				return SecurityPolicy.Aes256_Sha256_RsaPss;
			default:
				return SecurityPolicy.None;
		}
	}
}
