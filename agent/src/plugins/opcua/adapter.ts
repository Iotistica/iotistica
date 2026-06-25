/**
 * OPC-UA Protocol Adapter
 * 
 * Implements the BaseProtocolAdapter for OPC-UA (OPC Unified Architecture) devices.
 * This adapter handles connection management, data reading, and error handling for
 * OPC-UA industrial automation devices.
 * 
 * Features:
 * - Automatic endpoint discovery and selection
 * - Username/password authentication
 * - Security mode and policy support
 * - Node browsing and validation
 * - Automatic reconnection with exponential backoff
 * - Data type conversion and scaling
 * 
 * Example OPC-UA device configuration (stored in SQLite devices table):
 * {
 *   "name": "plc-001",
 *   "protocol": "opcua",
 *   "enabled": true,
 *   "pollInterval": 5000,
 *   "connection": {
 *     "endpointUrl": "opc.tcp://10.0.0.60:4840",
 *     "username": "admin",
 *     "password": "password",
 *     "securityMode": "None",
 *     "securityPolicy": "None",
 *     "connectionTimeout": 10000,
 *     "sessionTimeout": 60000,
 *     "keepAliveInterval": 5000
 *   },
 *   "dataPoints": [
 *     {
 *       "name": "temperature",
 *       "nodeId": "ns=2;s=Temperature",
 *       "unit": "°C",
 *       "dataType": "number"
 *     },
 *     {
 *       "name": "pressure",
 *       "nodeId": "ns=2;s=Pressure",
 *       "unit": "bar",
 *       "dataType": "number",
 *       "scalingFactor": 0.01
 *     }
 *   ],
 *   "metadata": {
 *     "manufacturer": "Siemens",
 *     "model": "S7-1500",
 *     "applicationUri": "urn:example:plc001"
 *   }
 * }
 * 
 * @module opcua-adapter
 */

// @ts-ignore - Optional dependency: node-opcua-client may not be installed
import {
	type ClientSession,
	type DataValue,
	AttributeIds,
	TimestampsToReturn,
	MonitoringParametersOptions as _MonitoringParametersOptions,
	type ReadValueIdOptions,
	DataType as _DataType,
} from 'node-opcua-client';
import { BaseProtocolAdapter, type GenericDeviceConfig } from '../base.js';
import { type DeviceDataPoint, type Logger, type IProtocolAdapter } from '../types.js';
import { ConsoleLogger } from '../logger.js';
import {
	type OPCUADeviceConfig,
	type OPCUADataPoint,
} from './types.js';
import { OPCUADeviceClient, type OPCUASession } from './client.js';

/**
 * OPC-UA Protocol Adapter
 * 
 * Extends BaseProtocolAdapter to provide OPC-UA-specific functionality.
 * Manages OPC-UA client connections, sessions, and data reading.
 */
export class OPCUAAdapter extends BaseProtocolAdapter  {
	private clients: Map<string, OPCUADeviceClient> = new Map();
	private sessions: Map<string, OPCUASession> = new Map();

	// Human-readable names resolved from the OPC-UA server at connect time.
	// Populated from: metadata.displayName (config override) > server DisplayName attribute > unset
	private resolvedDeviceNames: Map<string, string> = new Map();

	// Per-node display names read from the OPC-UA server's parent folder nodes.
	// Keyed by value-variable nodeId. Populated when the server advertises a DisplayName
	// on the parent device folder (e.g. simulator profile "displayName" field).
	// Takes precedence over resolvedDeviceNames when present.
	private resolvedNodeDisplayNames: Map<string, string> = new Map();
  
	// Subscription splitting (many PLCs struggle with 200+ monitored items)
	private readonly MAX_MONITORED_ITEMS_PER_SUBSCRIPTION = 100; // Split subscriptions beyond this
  
	// Reconnection settings
	private readonly MIN_RETRY_DELAY = 5000;   // 5 seconds
	private readonly MAX_RETRY_DELAY = 60000;  // 60 seconds
	private readonly MAX_RETRY_ATTEMPTS = 10;  // Cap consecutive failures
  
	// Read retry settings (passed into runtime OPCUADeviceClient)
	private readonly MAX_READ_RETRIES = 3;
	private readonly READ_RETRY_DELAY = 100;

	// Rediscovery throttle: only emit 'rediscovery-needed' once per device per cooldown period
	private readonly REDISCOVERY_COOLDOWN_MS = 30000; // 30 seconds
	private lastRediscoveryNeeded: Map<string, number> = new Map();

	private extractNodeScope(nodeId: string): string {
		const stringNodeMatch = nodeId.match(/^ns=(\d+);s=(.+)$/);
		if (stringNodeMatch) {
			const namespace = stringNodeMatch[1];
			const identifier = stringNodeMatch[2].trim();
			const segments = identifier.split(/[\\/.]/).filter(Boolean);
			const scope = segments.length > 1 ? segments.slice(0, -1).join('/') : identifier;
			return `ns${namespace}:s:${scope}`;
		}

		const numericNodeMatch = nodeId.match(/^ns=(\d+);i=(\d+)$/);
		if (numericNodeMatch) {
			return `ns${numericNodeMatch[1]}:i:${numericNodeMatch[2]}`;
		}

		return nodeId.replace(/\s+/g, '_');
	}

	/**
   * Derives the parent folder node ID from a string-addressed value variable.
   * e.g. "ns=2;s=Temperature/Device1/temperature" → "ns=2;s=Temperature/Device1"
   * Returns null for flat or non-string node IDs that have no resolvable parent.
   */
	private deriveParentNodeId(nodeId: string): string | null {
		const match = nodeId.match(/^(ns=\d+;s=)(.+)\/[^/]+$/);
		if (!match) return null;
		return `${match[1]}${match[2]}`;
	}


	private buildStableNodeDeviceId(device: OPCUADeviceConfig, dataPoint: OPCUADataPoint): string {
		const endpointKey = device.connection.endpointUrl
			.replace(/^opc\.tcp:\/\//i, '')
			.toLowerCase();
		const nodeScope = this.extractNodeScope(dataPoint.nodeId);
		return `opcua:${endpointKey}:${nodeScope}`;
	}

	/**
   * Creates a new OPC-UA adapter instance
   * 
   * @param devices - Array of OPC-UA device configurations
   * @param logger - Logger instance (optional, defaults to ConsoleLogger)
   */
	constructor(devices: OPCUADeviceConfig[], logger?: Logger) {
		super(devices as GenericDeviceConfig[], logger || new ConsoleLogger('debug'));
	}
  
	/**
   * Classify node as metric or metadata using hierarchy of authority:
   * 
   * 1. Explicit semantic config (HIGHEST - user intent overrides everything)
   * 2. Well-known semantic prefixes (STRONG - serverinfo_*, deviceinfo_*, metadata_*)
   * 3. OPC UA metadata heuristics (WEAK - NodeClass, DataType)
   * 4. Data type (LAST RESORT - numeric = metric, non-numeric = metadata)
   * 
   * Why this hierarchy?
   * - Semantics cannot be inferred from data type alone
   * - firmware_version (UInt32) is metadata, not metric
   * - line1_speed_rpm (Int32) is metric, not metadata
   * - Only user knows semantic intent
   * 
   * @param nodeClass - OPC UA NodeClass value
   * @param dataTypeNodeId - OPC UA DataType NodeId
   * @param key - Node key/name for pattern matching
   * @param explicitSemantic - Explicit user-provided classification (highest authority)
   * @returns Node type classification
   */
	private classifyNodeByMetadata(
		nodeClass: any, 
		dataTypeNodeId: any, 
		key: string,
		explicitSemantic?: 'metric' | 'metadata'
	): 'metric' | 'metadata' | 'ignore' {
		// Only process Variable nodes (not Object, Method, etc.)
		// OPC UA NodeClass: Object=1, Variable=2, Method=4, ObjectType=8, VariableType=64
		if (nodeClass !== 2) { // NodeClass.Variable = 2
			return 'ignore';
		}

		// 1. EXPLICIT SEMANTIC CONFIG (highest authority - user intent)
		// User explicitly marked this node as metric or metadata
		// This overrides all heuristics - use it when semantics cannot be inferred
		if (explicitSemantic) {
			return explicitSemantic;
		}

		// 2. WELL-KNOWN SEMANTIC PREFIXES (strong hint)
		// serverinfo_*, deviceinfo_*, metadata_* are always metadata
		// This handles common patterns but can be overridden by explicit config (#1)
		if (key.startsWith('serverinfo_') || key.startsWith('deviceinfo_') || key.startsWith('metadata_')) {
			return 'metadata';
		}

		// 3. OPC UA METADATA HEURISTICS (weak hint - extract DataType from NodeId)
		// Extract numeric identifier from NodeId (handle both numeric and object forms)
		let dataType: number;
		if (typeof dataTypeNodeId === 'number') {
			dataType = dataTypeNodeId;
		} else if (dataTypeNodeId && typeof dataTypeNodeId === 'object') {
			// NodeId object - extract value/identifier
			dataType = dataTypeNodeId.value || dataTypeNodeId.identifier;
		} else {
			// Unknown format - default to metadata
			return 'metadata';
		}

		// 4. DATA TYPE (last resort - technical type, not semantic meaning)
		// Numeric data types = metrics (time-series telemetry)
		// Non-numeric = metadata (configuration, diagnostics, info)
		// OPC UA standard numeric types in namespace 0
		const numericDataTypes = [
			2,  // SByte
			3,  // Byte
			4,  // Int16
			5,  // UInt16
			6,  // Int32
			7,  // UInt32
			8,  // Int64
			9,  // UInt64
			10, // Float
			11, // Double
		];

		if (numericDataTypes.includes(dataType)) {
			return 'metric';
		}

		// Non-numeric = metadata (strings, booleans, etc.)
		return 'metadata';
	}

	/**
   * Validate that NodeIDs exist and are accessible
   * Prevents runtime errors from misconfigured or missing nodes
   * Also auto-classifies nodes based on OPC UA metadata (NodeClass, DataType)
   * 
   * @param session - Active OPC-UA session
   * @param dataPoints - Data points to validate
   * @param deviceName - Device name (for logging)
   * @returns Object with valid data points and list of invalid NodeIDs
   */
	private async validateNodeIds(
		session: ClientSession,
		dataPoints: OPCUADataPoint[],
		deviceName: string
	): Promise<{ valid: OPCUADataPoint[], invalid: string[] }> {
		const valid: OPCUADataPoint[] = [];
		const invalid: string[] = [];

		this.logger.debug(`Validating ${dataPoints.length} NodeIDs for ${deviceName}...`);

		// PERFORMANCE: Batch all reads into single request
		// Before: 4 RTTs per node (Value, NodeClass, DataType, Description)
		// After: 1 RTT for all nodes × all attributes
		// Impact: 1000 nodes = 4000 RTTs → 1 RTT (4000x faster!)
		const nodesToRead: ReadValueIdOptions[] = [];
    
		for (const dp of dataPoints) {
			nodesToRead.push(
				{ nodeId: dp.nodeId, attributeId: AttributeIds.Value },
				{ nodeId: dp.nodeId, attributeId: AttributeIds.NodeClass },
				{ nodeId: dp.nodeId, attributeId: AttributeIds.DataType },
				{ nodeId: dp.nodeId, attributeId: AttributeIds.Description }
			);
		}
    
		const validationStart = Date.now();
		const results = await session.read(nodesToRead);
		const validationTime = Date.now() - validationStart;
    
		this.logger.debug(`Batch validation completed in ${validationTime}ms`, {
			deviceName,
			nodeCount: dataPoints.length,
			readCount: nodesToRead.length,
			avgTimePerNode: Math.round(validationTime / dataPoints.length)
		});
    
		// Parse results (4 consecutive results per data point)
		for (let i = 0; i < dataPoints.length; i++) {
			const dp = dataPoints[i];
			const baseIdx = i * 4;
			const valueResult = results[baseIdx];
			const nodeClassResult = results[baseIdx + 1];
			const dataTypeResult = results[baseIdx + 2];
			const descriptionResult = results[baseIdx + 3];

			// Check if reads were successful
			if (!valueResult.statusCode.isGood()) {
				invalid.push(dp.nodeId);
				this.logger.warn(`NodeID validation failed: ${dp.nodeId} (${dp.name})`, {
					deviceName,
					statusCode: valueResult.statusCode.name,
					description: valueResult.statusCode.description
				});
				continue;
			}

			// Extract metadata
			const nodeClass = nodeClassResult.value?.value;
			const dataTypeNodeId = dataTypeResult.value?.value;

			// Auto-populate unit from Description if not already set
			// OPC UA Description often contains unit info (e.g., "Temperature in °C")
			if (!dp.unit && descriptionResult.statusCode.isGood()) {
				const description = descriptionResult.value?.value?.text || descriptionResult.value?.value;
				if (description && typeof description === 'string') {
					// Extract unit from description - supports both simple and composite units
					// Pattern matches: "in {unit}" or "{unit}" at end of string
					// Examples: "Temperature in °C", "Flow in L/min", "Vibration in mm/s"
					const inUnitMatch = description.match(/\bin\s+([^\s,]+(?:\/[^\s,]+)?)/i);
					if (inUnitMatch) {
						(dp as any).unit = inUnitMatch[1];
					}
				}
			}

			// Classify using hierarchy of authority: semantic > prefixes > OPC UA metadata > datatype
			const explicitSemantic = (dp as any).semantic; // User-provided semantic intent
			const classified = this.classifyNodeByMetadata(nodeClass, dataTypeNodeId, dp.name, explicitSemantic);

			// Skip nodes that should be ignored (non-Variable nodes)
			if (classified === 'ignore') {
				this.logger.debug(`Skipping non-Variable node: ${dp.nodeId} (${dp.name})`, {
					deviceName,
					nodeClass
				});
				continue;
			}

			// Set computed nodeType (result of classification)
			(dp as any).nodeType = classified;

			// Only include metrics in validated nodes (metadata excluded from polling/subscription)
			if (classified === 'metric') {
				valid.push(dp);
			}
		}

		// Log summary
		this.logger.debug(`NodeID validation complete: ${valid.length} metrics, ${invalid.length} invalid`, {
			deviceName,
			validNodes: valid.map(dp => dp.nodeId),
			invalidNodes: invalid
		});

		return { valid, invalid };
	}

	/**
   * Read metadata nodes once and emit on separate channel
   * Metadata is read on connect/reconnect, not part of time-series polling
   * 
   * @param session - Active OPC-UA session
   * @param dataPoints - All data points (will filter for metadata)
   * @param deviceName - Device name (for logging)
   */
	private async readMetadata(
		session: ClientSession,
		dataPoints: OPCUADataPoint[],
		deviceName: string
	): Promise<void> {
		// Filter to only metadata nodes
		const metadataNodes = dataPoints.filter(dp => 
			(dp).nodeType === 'metadata'
		);

		if (metadataNodes.length === 0) {
			this.logger.debug(`No metadata nodes to read for ${deviceName}`);
			return;
		}

		this.logger.debug(`Reading ${metadataNodes.length} metadata nodes for ${deviceName}...`);

		const timestamp = new Date().toISOString();
		const metadataRecords: any[] = [];

		for (const dp of metadataNodes) {
			try {
				const dataValue = await session.readVariableValue(dp.nodeId);

				if (dataValue.statusCode.isGood()) {
					metadataRecords.push({
						deviceName,
						key: dp.name,
						value: dataValue.value?.value,
						nodeId: dp.nodeId,
						updatedAt: timestamp,
					});
				} else {
					this.logger.warn(`Failed to read metadata: ${dp.name}`, {
						deviceName,
						nodeId: dp.nodeId,
						statusCode: dataValue.statusCode.name,
					});
				}
			} catch (error) {
				this.logger.error(`Error reading metadata: ${dp.name}`, {
					deviceName,
					nodeId: dp.nodeId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Emit metadata on separate channel (not 'data')
		if (metadataRecords.length > 0) {
			this.emit('metadata', metadataRecords);
		}
	}

	/**
   * Create subscription for real-time data streaming
   * Sets up monitored items for all configured data points
   * Data changes will emit events instead of requiring polling
   * 
   * @param deviceName - Device name
   * @param device - Device configuration
   * @param sessionWrapper - Active session wrapper
   */
	private async createSubscription(
		deviceName: string,
		device: OPCUADeviceConfig,
		sessionWrapper: OPCUASession
	): Promise<void> {
		if (!sessionWrapper.session) {
			throw new Error(`No active session for device: ${deviceName}`);
		}

		const { session } = sessionWrapper;
		const { connection, dataPoints } = device;

		// Filter to only validated metric nodes (exclude metadata)
		const validDataPoints = dataPoints.filter(dp => 
			sessionWrapper.validatedNodes.has(dp.nodeId) && 
      (dp).nodeType === 'metric'
		);

		if (validDataPoints.length === 0) {
			this.logger.warn(`No valid NodeIDs to subscribe for ${deviceName}`);
			return;
		}

		// PERFORMANCE: Split into multiple subscriptions if node count exceeds limit
		// Many PLCs struggle with 200+ monitored items per subscription
		// Symptoms: missed publishes, queue overflows, silent throttling
		const maxItemsPerSub = connection.maxMonitoredItemsPerSubscription || this.MAX_MONITORED_ITEMS_PER_SUBSCRIPTION;
		const subscriptionCount = Math.ceil(validDataPoints.length / maxItemsPerSub);
    
		if (subscriptionCount > 1) {
			this.logger.debug(`Splitting ${validDataPoints.length} nodes into ${subscriptionCount} subscriptions`, {
				deviceName,
				maxItemsPerSub,
				reason: 'plc_load_distribution'
			});
		}

		sessionWrapper.subscriptions = [];

		// Create subscriptions (one or more depending on node count)
		for (let subIdx = 0; subIdx < subscriptionCount; subIdx++) {
			const startIdx = subIdx * maxItemsPerSub;
			const endIdx = Math.min(startIdx + maxItemsPerSub, validDataPoints.length);
			const batchDataPoints = validDataPoints.slice(startIdx, endIdx);

			// Create subscription
			const subscription = await session.createSubscription2({
				requestedPublishingInterval: connection.publishingInterval || 1000,
				requestedLifetimeCount: 100,
				requestedMaxKeepAliveCount: 10,
				maxNotificationsPerPublish: 100,
				publishingEnabled: true,
				priority: 10,
			});

			sessionWrapper.subscriptions.push(subscription);
      
			// Set legacy field for backwards compatibility (first subscription)
			if (subIdx === 0) {
				sessionWrapper.subscription = subscription;
			}

			this.logger.debug(`Created subscription ${subIdx + 1}/${subscriptionCount} for ${deviceName}`, {
				publishingInterval: connection.publishingInterval || 1000,
				samplingInterval: connection.samplingInterval || 500,
				itemCount: batchDataPoints.length,
				totalItems: validDataPoints.length,
			});

			// Create monitored items for this subscription's batch
			for (const dp of batchDataPoints) {
				try {
					const itemToMonitor = {
						nodeId: dp.nodeId,
						attributeId: AttributeIds.Value,
					};

					const parameters = {
						samplingInterval: connection.samplingInterval || 500,
						discardOldest: true,
						queueSize: 10,
					};

					const monitoredItem = await subscription.monitor(
						itemToMonitor,
						parameters,
						TimestampsToReturn.Both
					);

					// Handle data changes (real-time streaming)
					monitoredItem.on('changed', (dataValue: DataValue) => {
						// Hard gate: Never emit metadata nodes
						if ((dp).nodeType !== 'metric') {
							this.logger.warn(`Blocked metadata node emission: ${dp.name}`, { deviceName });
							return;
						}

						const quality = this.determineQuality(dataValue.statusCode);
						const qualityCode = quality !== 'GOOD' ? this.extractQualityCode(dataValue.statusCode) : undefined;

						const dataPoint: DeviceDataPoint = {
							timestamp: new Date().toISOString(),
							deviceName,
							deviceId: this.buildStableNodeDeviceId(device, dp),
							metric: dp.name,
							value: dataValue.value?.value ?? null,
							unit: dp.unit || '',
							quality,
							...(qualityCode && { qualityCode }),  // Only include if quality != GOOD
							protocol: 'opcua',  // For enum namespacing
							nodeType: 'metric', // Always 'metric' at this point (metadata filtered)
							...(dp.device_uuid && { device_uuid: dp.device_uuid }),
							...((this.resolvedNodeDisplayNames.has(dp.nodeId) || this.resolvedDeviceNames.has(deviceName)) && {
								resolvedDisplayName: this.resolvedNodeDisplayNames.get(dp.nodeId) ?? this.resolvedDeviceNames.get(deviceName),
							}),
						};

						// Emit immediately (real-time streaming)
						this.emit('data', [dataPoint]);
					});

					// Handle errors
					monitoredItem.on('err', (errorMessage: string) => {
						this.logger.error(`Monitored item error for ${dp.name}: ${errorMessage}`, {
							deviceName,
							nodeId: dp.nodeId,
						});
					});

					sessionWrapper.monitoredItems.set(dp.nodeId, monitoredItem);
				} catch (error) {
					this.logger.error(`Failed to create monitored item for ${dp.name}: ${error}`, {
						deviceName,
						nodeId: dp.nodeId,
					});
				}
			}

			// Handle subscription errors
			subscription.on('terminated', () => {
				this.logger.warn(`Subscription ${subIdx + 1} terminated for ${deviceName}`);
			});

			subscription.on('keepalive', () => {
				// keepalive: subscription is healthy, no action needed
			});
		}
	}

	/**
   * Extract normalized quality code from OPC-UA status code
   * Maps OPC-UA status codes to standard quality codes for pipeline consistency
   * 
   * @param statusCode - OPC-UA status code or error message
   * @returns Normalized quality code string
   */
	protected extractQualityCode(statusCode: any): string {
		if (!statusCode) {
			return 'UNKNOWN_ERROR';
		}
    
		const statusName = statusCode.name || statusCode.toString();
    
		// Session/Connection errors
		if (statusName.includes('BadSessionClosed') || statusName.includes('BadSessionIdInvalid')) {
			return 'SESSION_CLOSED';
		}
		if (statusName.includes('BadSecureChannelClosed') || statusName.includes('BadSecureChannelIdInvalid')) {
			return 'SECURE_CHANNEL_CLOSED';
		}
		if (statusName.includes('BadConnectionClosed') || statusName.includes('BadConnectionRejected')) {
			return 'CONNECTION_REFUSED';
		}
		if (statusName.includes('BadCommunicationError')) {
			return 'COMMUNICATION_ERROR';
		}
		if (statusName.includes('BadServerHalted') || statusName.includes('BadServerNotConnected')) {
			return 'DEVICE_OFFLINE';
		}
    
		// Timeout errors
		if (statusName.includes('BadTimeout') || statusName.includes('BadRequestTimeout')) {
			return 'TIMEOUT';
		}
    
		// Node/Data errors
		if (statusName.includes('BadNodeIdUnknown') || statusName.includes('BadNodeIdInvalid')) {
			return 'INVALID_NODE_ID';
		}
		if (statusName.includes('BadAttributeIdInvalid')) {
			return 'INVALID_ATTRIBUTE';
		}
		if (statusName.includes('BadDataUnavailable') || statusName.includes('BadWaitingForInitialData')) {
			return 'DATA_UNAVAILABLE';
		}
    
		// Security/Authentication errors
		if (statusName.includes('BadIdentityTokenInvalid') || statusName.includes('BadIdentityTokenRejected')) {
			return 'AUTHENTICATION_FAILED';
		}
		if (statusName.includes('BadUserAccessDenied') || statusName.includes('BadNotReadable')) {
			return 'ACCESS_DENIED';
		}
		if (statusName.includes('BadCertificate')) {
			return 'CERTIFICATE_ERROR';
		}
    
		// Data quality errors
		if (statusName.includes('BadOutOfRange')) {
			return 'VALUE_OUT_OF_RANGE';
		}
		if (statusName.includes('BadTypeMismatch')) {
			return 'TYPE_MISMATCH';
		}
    
		// Generic errors
		if (statusName.includes('BadUnexpectedError') || statusName.includes('BadInternalError')) {
			return 'INTERNAL_ERROR';
		}
		if (statusName.includes('BadNotSupported')) {
			return 'NOT_SUPPORTED';
		}
    
		// Return raw status name if no mapping found
		return statusName;
	}
  
	/**
   * Determine overall quality level from OPC-UA status code
   * Maps to standard quality levels: GOOD, UNCERTAIN, BAD
   * 
   * @param statusCode - OPC-UA status code
   * @returns Quality level
   */
	private determineQuality(statusCode: any): 'GOOD' | 'UNCERTAIN' | 'BAD' {
		if (!statusCode) {
			return 'BAD';
		}
    
		// OPC-UA has built-in quality checks
		if (statusCode.isGood?.()) {
			return 'GOOD';
		}
    
		const statusName = statusCode.name || statusCode.toString();
    
		// UNCERTAIN: Data available but quality questionable
		const uncertainPatterns = [
			'Uncertain',
			'BadWaitingForInitialData',
			'BadDataUnavailable',
		];
    
		if (uncertainPatterns.some(pattern => statusName.includes(pattern))) {
			return 'UNCERTAIN';
		}
    
		// BAD: Data invalid or unavailable
		return 'BAD';
	}
  
	/**
   * Returns the protocol name
   * Required by BaseProtocolAdapter
   */
	protected getProtocolName(): string {
		return 'opcua';
	}

	/**
   * Validates OPC-UA device configuration
   * Checks for required fields and valid values
   * 
   * @param device - Device configuration to validate
   * @throws Error if configuration is invalid
   */
	protected validateDeviceConfig(device: OPCUADeviceConfig): void {
		const { connection, dataPoints } = device;

		// Validate endpoint URL
		if (!connection.endpointUrl) {
			throw new Error(`Device ${device.name}: endpointUrl is required`);
		}

		if (!connection.endpointUrl.startsWith('opc.tcp://')) {
			throw new Error(
				`Device ${device.name}: endpointUrl must start with 'opc.tcp://'`
			);
		}

		// Validate data points (if provided)
		// Empty dataPoints triggers auto-discovery mode
		if (dataPoints && dataPoints.length > 0) {
			for (const dp of dataPoints) {
				if (!dp.name) {
					throw new Error(`Device ${device.name}: data point name is required`);
				}
				if (!dp.nodeId) {
					throw new Error(
						`Device ${device.name}: nodeId is required for data point ${dp.name}`
					);
				}
			}
		}

		// Validate authentication
		if (connection.username && !connection.password) {
			this.logger.warn(
				`Device ${device.name}: username provided without password`
			);
		}

		if (connection.expectedServerThumbprint) {
			const normalizedThumbprint = connection.expectedServerThumbprint.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
			if (normalizedThumbprint.length !== 40) {
				throw new Error(
					`Device ${device.name}: expectedServerThumbprint must be a 40-character SHA-1 thumbprint`
				);
			}
		}
	}

	/**
   * Connects to an OPC-UA device
   * Runtime connection details are delegated to OPCUADeviceClient.
   * 
   * @param device - Device configuration
   * @returns OPCUASession object with client and session
   */
	protected async connectDevice(device: OPCUADeviceConfig): Promise<OPCUASession> {
		const runtimeClient = new OPCUADeviceClient(device, this.logger, {
			minRetryDelay: this.MIN_RETRY_DELAY,
			maxReadRetries: this.MAX_READ_RETRIES,
			readRetryDelayMs: this.READ_RETRY_DELAY,
		});

		try {
			await runtimeClient.connect();
			const sessionWrapper = runtimeClient.getSessionWrapper();
			if (!sessionWrapper?.session) {
				throw new Error(`Failed to establish OPC-UA session for ${device.name}`);
			}

			const session = sessionWrapper.session;
			this.clients.set(device.name, runtimeClient);

			// Resolve human-readable display name for this device.
			// Only set when explicitly configured via metadata.displayName — do NOT read ns=0;i=2253
			// (the OPC-UA Server root object) because its DisplayName is always "Server" per the spec
			// and is unrelated to any device or device being polled.
			const configDisplayName = device.metadata?.displayName;
			if (configDisplayName?.trim()) {
				this.resolvedDeviceNames.set(device.name, configDisplayName.trim());
			}
      
			// Store session for reconnection access
			this.sessions.set(device.name, sessionWrapper);
      
			// Setup connection event handlers for automatic reconnection
			this.setupConnectionHandlers(device, sessionWrapper);
      
			// Setup session event handlers for keep-alive monitoring
			this.setupSessionHandlers(device, sessionWrapper);

			// No data points configured — trigger auto-browse via rediscovery rather than failing.
			// This self-heals endpoints that were added via discovery without validate:true.
			if (!device.dataPoints || device.dataPoints.length === 0) {
				const now = Date.now();
				const lastEmitted = this.lastRediscoveryNeeded.get(device.name) ?? 0;
				if (now - lastEmitted >= this.REDISCOVERY_COOLDOWN_MS) {
					this.lastRediscoveryNeeded.set(device.name, now);
					this.logger.warn(`OPC-UA device ${device.name} has no data points configured — triggering auto-browse`, {
						deviceName: device.name,
						endpointUrl: device.connection.endpointUrl,
					});
					this.emit('rediscovery-needed', {
						deviceName: device.name,
						endpointUrl: device.connection.endpointUrl,
					});
				}
				return sessionWrapper;
			}

			// Validate NodeIDs before creating subscription or reads
			const { valid: validDataPoints, invalid: invalidNodeIds } = await this.validateNodeIds(
				session,
				device.dataPoints,
				device.name
			);

			// Cache validated NodeIDs (only metrics)
			validDataPoints.forEach(dp => sessionWrapper.validatedNodes.add(dp.nodeId));

			// Warn if some nodes are invalid
			if (invalidNodeIds.length > 0) {
				this.logger.warn(`Some NodeIDs are invalid and will be skipped`, {
					deviceName: device.name,
					invalidCount: invalidNodeIds.length,
					totalCount: device.dataPoints.length,
					invalidNodes: invalidNodeIds
				});
			}

			// Detect OPC-UA server profile change: if ≥80% of configured nodes fail, the server
			// likely switched to a different profile (e.g., OPC-UA simulator hot-reload).
			// Emit 'rediscovery-needed' so the agent can re-browse the server and update the DB.
			// Throttled per device to avoid flooding discovery when the server is restarting.
			const totalConfigured = device.dataPoints.length;
			if (totalConfigured > 0 && invalidNodeIds.length / totalConfigured >= 0.8) {
				const now = Date.now();
				const lastEmitted = this.lastRediscoveryNeeded.get(device.name) ?? 0;
				if (now - lastEmitted >= this.REDISCOVERY_COOLDOWN_MS) {
					this.lastRediscoveryNeeded.set(device.name, now);
					const failurePct = Math.round((invalidNodeIds.length / totalConfigured) * 100);
					this.logger.warn(
						`High NodeID failure rate (${failurePct}% of ${totalConfigured} nodes invalid) - OPC-UA server may have a different profile. Requesting rediscovery.`,
						{
							deviceName: device.name,
							endpointUrl: device.connection.endpointUrl,
							invalidCount: invalidNodeIds.length,
							totalCount: totalConfigured
						}
					);
					this.emit('rediscovery-needed', {
						deviceName: device.name,
						endpointUrl: device.connection.endpointUrl
					});
				}
			}

			// Log classification summary
			const metadataCount = device.dataPoints.filter(dp => 
				(dp).nodeType === 'metadata'
			).length;
      
			this.logger.debug(`Node classification summary for ${device.name}`, {
				total: device.dataPoints.length,
				metrics: validDataPoints.length,
				metadata: metadataCount,
				invalid: invalidNodeIds.length
			});

			// If all metric nodes are invalid but we have metadata, that's ok (metadata-only device)
			if (validDataPoints.length === 0 && metadataCount === 0) {
				throw new Error(`All NodeIDs failed validation for device ${device.name}. Possibly no data points discovered for thsi device.`);
			}

			// Read metadata nodes once on connect (separate from time-series)
			await this.readMetadata(session, device.dataPoints, device.name);

			// Read per-node DisplayNames from parent device folder nodes.
			// Allows OPC-UA servers (e.g. simulator profiles with a "displayName" field) to
			// advertise human-readable names per device group. These override the raw endpoint
			// name when building the device_name in readings. Batched in a single read call.
			if (validDataPoints.length > 0) {
				const nodeToParent = new Map<string, string>();
				for (const dp of validDataPoints) {
					const parentId = this.deriveParentNodeId(dp.nodeId);
					if (parentId) nodeToParent.set(dp.nodeId, parentId);
				}
				if (nodeToParent.size > 0) {
					const uniqueParents = [...new Set(nodeToParent.values())];
					const parentToChildren = new Map<string, string[]>();
					for (const [nodeId, parentId] of nodeToParent) {
						if (!parentToChildren.has(parentId)) parentToChildren.set(parentId, []);
            parentToChildren.get(parentId)!.push(nodeId);
					}
					try {
						const readResults = await session.read(
							uniqueParents.map(parentId => ({ nodeId: parentId, attributeId: AttributeIds.DisplayName }))
						);
						readResults.forEach((result, i) => {
							const text = result?.value?.value?.text;
							if (text && typeof text === 'string' && text.trim()) {
								for (const nodeId of parentToChildren.get(uniqueParents[i]) ?? []) {
									this.resolvedNodeDisplayNames.set(nodeId, text.trim());
								}
								this.logger.debug(`Resolved per-node DisplayName for ${uniqueParents[i]}: "${text.trim()}"`);
							}
						});
					} catch {
						// Non-fatal: per-node names unavailable, falls back to endpoint name or device.name
					}
				}
			}

			// Create subscription if enabled (real-time streaming)
			if (device.connection.useSubscription && validDataPoints.length > 0) {
				try {
					await this.createSubscription(device.name, device, sessionWrapper);
					this.logger.debug(`Subscription mode enabled for ${device.name} - using real-time streaming`);
				} catch (error) {
					this.logger.error(`Failed to create subscription for ${device.name}: ${error}`);
					this.logger.warn(`Falling back to polling mode for ${device.name}`);
				}
			}

			return sessionWrapper;
		} catch (error) {
			await runtimeClient.disconnect().catch(() => {});
			throw error;
		}
	}

	/**
   * Setup connection event handlers for automatic reconnection
   * Handles connection_lost, backoff, close, and abort events
   */
	private setupConnectionHandlers(device: OPCUADeviceConfig, sessionWrapper: OPCUASession): void {
		const { client } = sessionWrapper;
    
		// Connection lost - server unavailable or network issue
		client.on('connection_lost', () => {
			this.logger.warn(`Connection lost to OPC-UA device: ${device.name}`);
			this.emit('device-disconnected', device.name);
			this.scheduleReconnect(device, sessionWrapper, 'connection_lost');
		});
    
		// Backoff event - client is retrying internally
		client.on('backoff', (retry: number, delay: number) => {
			this.logger.warn(`OPC-UA client backoff for ${device.name}`, {
				retry,
				delayMs: delay,
				reason: 'internal_retry'
			});
		});
    
		// Close event - client connection closed
		client.on('close', () => {
			if (!sessionWrapper.reconnecting) {
				this.logger.warn(`OPC-UA client closed for ${device.name}`);
				this.scheduleReconnect(device, sessionWrapper, 'close');
			}
		});
    
		// Abort event - connection attempt failed
		client.on('abort', () => {
			this.logger.error(`OPC-UA connection aborted for ${device.name}`);
			this.scheduleReconnect(device, sessionWrapper, 'abort');
		});
    
		// Keep-alive failure - session timeout
		client.on('keepalive_failure', () => {
			this.logger.warn(`Keep-alive failure for ${device.name}`);
			this.scheduleReconnect(device, sessionWrapper, 'keepalive_failure');
		});
	}
  
	/**
   * Setup session event handlers for keep-alive monitoring
   * Detects when server silently closes session or keep-alive fails
   */
	private setupSessionHandlers(device: OPCUADeviceConfig, sessionWrapper: OPCUASession): void {
		const { session } = sessionWrapper;
    
		if (!session) {
			return;
		}
    
		// Session closed by server - session is now invalid
		session.on('session_closed', () => {
			this.logger.warn(`OPC-UA session closed by server for ${device.name}`, {
				reason: 'session_closed_event',
				note: 'Session invalidated by server'
			});
			this.scheduleReconnect(device, sessionWrapper, 'session_closed');
		});
    
		// Keep-alive success - session is healthy
		session.on('keepalive', () => {
			this.logger.debug(`Keep-alive successful for ${device.name}`);
			// Session is healthy, no action needed
		});
    
		// Keep-alive failure - session may be dead
		session.on('keepalive_failure', () => {
			this.logger.error(`Session keep-alive failure for ${device.name}`, {
				reason: 'keepalive_failure_event',
				note: 'Session may be invalid, reconnecting'
			});
			this.scheduleReconnect(device, sessionWrapper, 'session_keepalive_failure');
		});
	}
  
	/**
   * Schedule reconnection with exponential backoff
   */
	private scheduleReconnect(device: OPCUADeviceConfig, sessionWrapper: OPCUASession, reason: string): void {
		// Skip if already reconnecting
		if (sessionWrapper.reconnecting) {
			return;
		}
    
		sessionWrapper.reconnecting = true;
		sessionWrapper.consecutiveFailures = Math.min(
			sessionWrapper.consecutiveFailures + 1,
			this.MAX_RETRY_ATTEMPTS
		);
    
		// Calculate exponential backoff delay
		let delay = Math.min(
			sessionWrapper.currentRetryDelay,
			this.MAX_RETRY_DELAY
		);
    
		// PERFORMANCE: Add random jitter (0-500ms) to prevent thundering herd
		// When 50+ devices reconnect simultaneously:
		// - CPU spikes from validation/subscription bursts
		// - Downstream event-storm pressure
		// - Network congestion
		// Jitter staggers reconnects to smooth out load
		const jitter = Math.random() * 500;
		delay += jitter;
    
		this.logger.debug(`Scheduling reconnect for ${device.name}`, {
			reason,
			baseDelayMs: sessionWrapper.currentRetryDelay,
			jitterMs: Math.round(jitter),
			totalDelayMs: Math.round(delay),
			consecutiveFailures: sessionWrapper.consecutiveFailures,
			maxRetryDelay: this.MAX_RETRY_DELAY
		});
    
		// Clear existing timer if any
		if (sessionWrapper.reconnectTimer) {
			clearTimeout(sessionWrapper.reconnectTimer);
		}
    
		// Schedule reconnection attempt
		sessionWrapper.reconnectTimer = setTimeout(async () => {
			await this.attemptReconnect(device, sessionWrapper);
		}, delay);
    
		// Increase delay for next attempt (exponential backoff)
		sessionWrapper.currentRetryDelay = Math.min(
			sessionWrapper.currentRetryDelay * 2,
			this.MAX_RETRY_DELAY
		);
	}
  
	/**
   * Attempt to reconnect to OPC-UA device
   */
	private async attemptReconnect(device: OPCUADeviceConfig, sessionWrapper: OPCUASession): Promise<void> {
		this.logger.debug(`Attempting reconnect to OPC-UA device: ${device.name}`, {
			attempt: sessionWrapper.consecutiveFailures,
			maxAttempts: this.MAX_RETRY_ATTEMPTS
		});
    
		try {
			// Clean up old client/session if they exist
			const runtimeClient = this.clients.get(device.name);
			if (runtimeClient) {
				await runtimeClient.cleanup(false);
			} else {
				await this.cleanupSession(sessionWrapper, false);
			}
      
			// Create new connection
			const newSession = await this.connectDevice(device);
      
			// Update session wrapper with new connection
			sessionWrapper.client = newSession.client;
			sessionWrapper.session = newSession.session;
			sessionWrapper.subscription = newSession.subscription;
			sessionWrapper.reconnecting = false;
      
			// Reset backoff on successful reconnection
			sessionWrapper.currentRetryDelay = this.MIN_RETRY_DELAY;
			sessionWrapper.consecutiveFailures = 0;
      
			this.logger.debug(`Reconnected successfully to ${device.name}`);
			this.emit('device-connected', device.name);
      
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Reconnection failed for ${device.name}: ${errorMessage}`);
			this.emit('device-error', device.name, error as Error);
      
			// Check if we've exceeded max attempts
			if (sessionWrapper.consecutiveFailures >= this.MAX_RETRY_ATTEMPTS) {
				this.logger.error(`Max reconnection attempts reached for ${device.name}`, {
					maxAttempts: this.MAX_RETRY_ATTEMPTS,
					note: 'Will retry at max delay interval'
				});
			}
      
			// Schedule next retry
			sessionWrapper.reconnecting = false; // Allow scheduleReconnect to run
			this.scheduleReconnect(device, sessionWrapper, 'reconnect_failed');
		}
	}
  
	/**
   * Clean up session and client without removing from sessions map
   */
	private async cleanupSession(sessionWrapper: OPCUASession, clearTimer: boolean = true): Promise<void> {
		// Clear reconnect timer
		if (clearTimer && sessionWrapper.reconnectTimer) {
			clearTimeout(sessionWrapper.reconnectTimer);
			sessionWrapper.reconnectTimer = undefined;
		}
    
		try {
			// Clear validated nodes cache
			sessionWrapper.validatedNodes.clear();
      
			// Clear monitored items
			sessionWrapper.monitoredItems.clear();
      
			// Close all subscriptions
			for (const subscription of sessionWrapper.subscriptions) {
				try {
					await subscription.terminate();
				} catch (_error) {
					// Ignore individual subscription errors
				}
			}
			sessionWrapper.subscriptions = [];
      
			// Close legacy subscription field
			if (sessionWrapper.subscription) {
				try {
					await sessionWrapper.subscription.terminate();
				} catch (_error) {
					// Ignore
				}
				sessionWrapper.subscription = null;
			}
      
			// Close session
			if (sessionWrapper.session) {
				await sessionWrapper.session.close();
				sessionWrapper.session = null;
			}
      
			// Disconnect client
			if (sessionWrapper.client) {
				await sessionWrapper.client.disconnect();
			}
		} catch (error) {
			// Ignore cleanup errors
			this.logger.debug(`Error during session cleanup: ${error}`);
		}
	}

	/**
   * Disconnects from an OPC-UA device
   * Closes session and client connection
   * 
   * @param deviceName - Name of device to disconnect
   */
	protected async disconnectDevice(deviceName: string): Promise<void> {
		const sessionWrapper = this.sessions.get(deviceName);
		const runtimeClient = this.clients.get(deviceName);
		if (!sessionWrapper && !runtimeClient) {
			return;
		}

		this.logger.debug(`Disconnecting OPC-UA device: ${deviceName}`);
	
		// Stop reconnection attempts
		if (sessionWrapper) {
			sessionWrapper.reconnecting = false;
		}
    
		try {
			if (sessionWrapper) {
				sessionWrapper.reconnecting = false;
			}

			if (runtimeClient) {
				await runtimeClient.disconnect();
			} else if (sessionWrapper) {
				await this.cleanupSession(sessionWrapper, true);
			}
			this.logger.debug(`Disconnected from device: ${deviceName}`);
		} catch (error) {
			this.logger.error(`Error disconnecting device ${deviceName}: ${error}`);
		} finally {
			this.clients.delete(deviceName);
			this.sessions.delete(deviceName);
			this.resolvedDeviceNames.delete(deviceName);
			// Clean up per-node display names for this device's data points
			const deviceConfig = this.devices.get(deviceName) as OPCUADeviceConfig | undefined;
			if (deviceConfig) {
				for (const dp of deviceConfig.dataPoints) {
					this.resolvedNodeDisplayNames.delete(dp.nodeId);
				}
			}
		}
	}

	/**
   * Reads data from an OPC-UA device
   * Reads all configured data points and converts to deviceDataPoint format
   * 
   * @param deviceName - Name of device to read
   * @param device - Device configuration
   * @returns Array of device data points
   */
	protected async readDeviceData(
		deviceName: string,
		device: OPCUADeviceConfig
	): Promise<DeviceDataPoint[]> {
		const runtimeClient = this.clients.get(deviceName);
		if (!runtimeClient) {
			throw new Error(`No OPC-UA runtime client for device: ${deviceName}`);
		}

		const sessionWrapper = this.sessions.get(deviceName);
		if (!sessionWrapper?.session) {
			throw new Error(`No active session for device: ${deviceName}`);
		}

		// If subscription is active, data comes via events - skip polling
		if (sessionWrapper.subscription && device.connection.useSubscription) {
			this.logger.debug(`Subscription active for ${deviceName} - skipping poll`);
			// Keep runtime health fresh in subscription mode. Without this, lastSeen and
			// communicationQuality stay stale even when monitored item updates are flowing.
			this.recordPollResult(deviceName, true, 0, 0);
			return [];
		}

		const { dataPoints } = device;

		// Filter to only validated metric nodes (exclude metadata)
		const validDataPoints = dataPoints.filter(dp => 
			sessionWrapper.validatedNodes.has(dp.nodeId) && 
      (dp).nodeType === 'metric'
		);

		if (validDataPoints.length === 0) {
			this.logger.warn(`No valid NodeIDs to read for ${deviceName}`);
			return [];
		}

		// Build read request for validated data points only
		const nodesToRead: ReadValueIdOptions[] = validDataPoints.map((dp) => ({
			nodeId: dp.nodeId,
			attributeId: AttributeIds.Value,
		}));

		const readStartedAt = Date.now();

		// Read all nodes with automatic retry for transient errors
		const dataValues: DataValue[] = await runtimeClient.read(nodesToRead);

		// Convert to deviceDataPoint format
		const results: DeviceDataPoint[] = [];
		const timestamp = new Date().toISOString();
		let goodValueCount = 0;

		for (let i = 0; i < validDataPoints.length; i++) {
			const dp = validDataPoints[i];
			const dataValue = dataValues[i];

			// Hard gate: Never process metadata nodes
			if ((dp).nodeType !== 'metric') {
				this.logger.warn(`Blocked metadata node read: ${dp.name}`, { deviceName });
				continue;
			}

			// Check if read was successful
			if (!dataValue.statusCode.isGood()) {
				const quality = this.determineQuality(dataValue.statusCode);
				const qualityCode = this.extractQualityCode(dataValue.statusCode);
        
				this.logger.warn(
					`Failed to read ${dp.name} from ${deviceName}: ${dataValue.statusCode.description}`,
					{
						quality,
						qualityCode,
						statusCode: dataValue.statusCode.name
					}
				);
        
				results.push({
					timestamp,
					deviceName,
					deviceId: this.buildStableNodeDeviceId(device, dp),
					metric: dp.name,
					value: null,
					unit: dp.unit || '',
					quality,
					qualityCode,
					nodeType: 'metric',
					...(dp.device_uuid && { device_uuid: dp.device_uuid }),
					...((this.resolvedNodeDisplayNames.has(dp.nodeId) || this.resolvedDeviceNames.has(deviceName)) && {
						resolvedDisplayName: this.resolvedNodeDisplayNames.get(dp.nodeId) ?? this.resolvedDeviceNames.get(deviceName),
					}),
				});
				continue;
			}

			// Extract and convert value
			let value = dataValue.value.value;

			// Apply scaling and offset if configured
			if (typeof value === 'number') {
				if (dp.scalingFactor) {
					value = value * dp.scalingFactor;
				}
				if (dp.offset) {
					value = value + dp.offset;
				}
			}

			results.push({
				timestamp,
				deviceName,
				deviceId: this.buildStableNodeDeviceId(device, dp),
				metric: dp.name,
				value,
				unit: dp.unit || '',
				quality: 'GOOD' as const,
				nodeType: 'metric',
				...(dp.device_uuid && { device_uuid: dp.device_uuid }),
				...((this.resolvedNodeDisplayNames.has(dp.nodeId) || this.resolvedDeviceNames.has(deviceName)) && {
					resolvedDisplayName: this.resolvedNodeDisplayNames.get(dp.nodeId) ?? this.resolvedDeviceNames.get(deviceName),
				}),
			});

			goodValueCount++;
		}

		// Mark poll success so endpoint health reports lastSeen/connected/quality correctly.
		this.recordPollResult(deviceName, goodValueCount > 0, Date.now() - readStartedAt, goodValueCount);

		return results;
	}

	/**
   * Override start to store sessions in map
   */
	public async start(): Promise<void> {
		await super.start();
	}

	/**
   * Override stop to clean up sessions
   */
	public async stop(): Promise<void> {
		await super.stop();
		this.clients.clear();
		this.sessions.clear();
	}

	/**
	 * Write a value to an OPC-UA node for a given device.
	 * Target can be either datapoint name or full nodeId.
	 */
	public async writeNode(
		deviceName: string,
		target: string,
		value: number | boolean | string
	): Promise<void> {
		const device = this.devices.get(deviceName) as OPCUADeviceConfig | undefined;
		if (!device) {
			throw new Error(`Device not found: ${deviceName}`);
		}

		const runtimeClient = this.clients.get(deviceName);
		if (!runtimeClient?.isConnected()) {
			throw new Error(`Device ${deviceName} is not connected`);
		}

		const dataPoint = device.dataPoints.find((dp) => dp.name === target || dp.nodeId === target);
		if (!dataPoint) {
			throw new Error(`Node not found on device ${deviceName}: ${target}`);
		}

		if (!dataPoint.writable) {
			throw new Error(`Node is not writable: ${dataPoint.name} (${dataPoint.nodeId})`);
		}

		await runtimeClient.write(dataPoint.nodeId, value);
	}
}
