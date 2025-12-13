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
 * Example OPC-UA device configuration (stored in SQLite sensors table):
 * {
 *   "name": "plc-001",
 *   "protocol": "opcua",
 *   "enabled": true,
 *   "pollInterval": 5000,
 *   "connection": {
 *     "endpointUrl": "opc.tcp://192.168.1.100:4840",
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

import { EventEmitter } from 'events';
// @ts-ignore - Optional dependency: node-opcua-client may not be installed
import {
  OPCUAClient,
  ClientSession,
  DataValue,
  AttributeIds,
  MessageSecurityMode,
  SecurityPolicy,
  UserTokenType,
  ClientSubscription,
  TimestampsToReturn,
  MonitoringParametersOptions,
  ReadValueIdOptions,
  ClientMonitoredItem,
  DataType,
} from 'node-opcua-client';
import { BaseProtocolAdapter, GenericDeviceConfig } from '../base.js';
import { SensorDataPoint, Logger } from '../types.js';
import { ConsoleLogger } from '../common/logger.js';
import {
  OPCUADeviceConfig,
  OPCUAConnection,
  OPCUADataPoint,
  OPCUASecurityMode,
  OPCUASecurityPolicy,
} from './types.js';

/**
 * OPC-UA Client Session Manager
 * Wraps OPCUAClient and ClientSession for a single device
 */
interface OPCUASession {
  client: OPCUAClient;
  session: ClientSession | null;
  subscription: ClientSubscription | null;
  monitoredItems: Map<string, ClientMonitoredItem>; // nodeId -> monitored item
  validatedNodes: Set<string>; // NodeIDs that passed validation
  reconnecting: boolean;
  reconnectTimer?: NodeJS.Timeout;
  currentRetryDelay: number;
  consecutiveFailures: number;
}

/**
 * OPC-UA Protocol Adapter
 * 
 * Extends BaseProtocolAdapter to provide OPC-UA-specific functionality.
 * Manages OPC-UA client connections, sessions, and data reading.
 */
export class OPCUAAdapter extends BaseProtocolAdapter {
  private sessions: Map<string, OPCUASession> = new Map();
  
  // Concurrency control: OPC-UA sessions do NOT support concurrent requests
  // Concurrent reads will cause BadSessionIdInvalid, BadSecureChannelClosed, or corrupted data
  private locks: Map<string, Promise<any>> = new Map();
  
  // Reconnection settings
  private readonly MIN_RETRY_DELAY = 5000;   // 5 seconds
  private readonly MAX_RETRY_DELAY = 60000;  // 60 seconds
  private readonly MAX_RETRY_ATTEMPTS = 10;  // Cap consecutive failures
  
  // Read retry settings
  private readonly MAX_READ_RETRIES = 3;     // Retry reads up to 3 times
  private readonly READ_RETRY_DELAY = 100;   // 100ms between retries

  /**
   * Creates a new OPC-UA adapter instance
   * 
   * @param devices - Array of OPC-UA device configurations
   */
  constructor(devices: OPCUADeviceConfig[]) {
    const logger = new ConsoleLogger('info');
    super(devices as GenericDeviceConfig[], logger);
  }
  
  /**
   * Validate that NodeIDs exist and are accessible
   * Prevents runtime errors from misconfigured or missing nodes
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

    this.logger.info(`Validating ${dataPoints.length} NodeIDs for ${deviceName}...`);

    for (const dp of dataPoints) {
      try {
        // Attempt to read the node to verify it exists and is accessible
        const dataValue = await session.readVariableValue(dp.nodeId);
        
        // Check if read was successful
        if (dataValue.statusCode.isGood()) {
          valid.push(dp);
          this.logger.debug(`✓ NodeID validated: ${dp.nodeId} (${dp.name})`, {
            deviceName,
            value: dataValue.value?.value,
            dataType: dataValue.value?.dataType
          });
        } else {
          invalid.push(dp.nodeId);
          this.logger.warn(`✗ NodeID validation failed: ${dp.nodeId} (${dp.name})`, {
            deviceName,
            statusCode: dataValue.statusCode.name,
            description: dataValue.statusCode.description
          });
        }
      } catch (error) {
        invalid.push(dp.nodeId);
        this.logger.error(`✗ NodeID validation error: ${dp.nodeId} (${dp.name})`, {
          deviceName,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Log summary
    if (invalid.length > 0) {
      this.logger.warn(`NodeID validation complete: ${valid.length} valid, ${invalid.length} invalid`, {
        deviceName,
        validNodes: valid.map(dp => dp.nodeId),
        invalidNodes: invalid
      });
    } else {
      this.logger.info(`✓ All ${valid.length} NodeIDs validated successfully for ${deviceName}`);
    }

    return { valid, invalid };
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

    // Filter to only validated nodes
    const validDataPoints = dataPoints.filter(dp => sessionWrapper.validatedNodes.has(dp.nodeId));

    if (validDataPoints.length === 0) {
      this.logger.warn(`No valid NodeIDs to subscribe for ${deviceName}`);
      return;
    }

    // Create subscription
    const subscription = await session.createSubscription2({
      requestedPublishingInterval: connection.publishingInterval || 1000,
      requestedLifetimeCount: 100,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 100,
      publishingEnabled: true,
      priority: 10,
    });

    sessionWrapper.subscription = subscription;

    this.logger.info(`Created subscription for ${deviceName}`, {
      publishingInterval: connection.publishingInterval || 1000,
      samplingInterval: connection.samplingInterval || 500,
      dataPointCount: validDataPoints.length,
      totalConfigured: dataPoints.length,
    });

    // Create monitored items for each validated data point
    for (const dp of validDataPoints) {
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
          const quality = this.determineQuality(dataValue.statusCode);
          const qualityCode = this.extractQualityCode(dataValue.statusCode);

          const dataPoint: SensorDataPoint = {
            timestamp: new Date().toISOString(),
            deviceName,
            registerName: dp.name,
            value: dataValue.value?.value ?? null,
            unit: dp.unit || '',
            quality,
            qualityCode,
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

        this.logger.debug(`Created monitored item for ${dp.name}`, {
          deviceName,
          nodeId: dp.nodeId,
        });
      } catch (error) {
        this.logger.error(`Failed to create monitored item for ${dp.name}: ${error}`, {
          deviceName,
          nodeId: dp.nodeId,
        });
      }
    }

    // Handle subscription errors
    subscription.on('terminated', () => {
      this.logger.warn(`Subscription terminated for ${deviceName}`);
      sessionWrapper.subscription = null;
      sessionWrapper.monitoredItems.clear();
    });

    subscription.on('keepalive', () => {
      this.logger.debug(`Subscription keepalive for ${deviceName}`);
    });
  }

  /**
   * Serialize OPC-UA requests per device to prevent concurrent access
   * OPC-UA sessions do NOT support concurrent operations - they will fail with:
   * - BadSessionIdInvalid
   * - BadSecureChannelClosed
   * - BadSequenceNumberUnknown
   * - Corrupted read results
   * 
   * @param deviceName - Device to lock
   * @param fn - Function to execute with exclusive access
   * @returns Result of the function
   */
  private async lock<T>(deviceName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(deviceName) || Promise.resolve();
    const next = prev.then(fn, fn); // Execute fn after previous completes (or fails)
    this.locks.set(deviceName, next.catch(() => {})); // Catch to prevent unhandled rejection
    return next;
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
    if (statusCode.isGood && statusCode.isGood()) {
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
   * Check if OPC-UA status code represents a transient error that should be retried
   * 
   * @param statusCode - OPC-UA status code
   * @returns True if error is transient and should be retried
   */
  private isTransientError(statusCode: any): boolean {
    if (!statusCode) {
      return false;
    }
    
    const statusName = statusCode.name || statusCode.toString();
    
    // Transient errors that often succeed on retry
    const transientPatterns = [
      'BadOutOfRange',           // Value temporarily out of range
      'BadNotConnected',         // Temporary connection issue
      'BadNoCommunication',      // Communication hiccup
      'BadTimeout',              // Network delay
      'BadCommunicationError',   // Transient network error
      'BadServerHalted',         // Server temporarily unavailable
      'BadDataUnavailable',      // Data not ready yet
      'BadWaitingForInitialData', // Waiting for initialization
    ];
    
    return transientPatterns.some(pattern => statusName.includes(pattern));
  }
  
  /**
   * Read node values with automatic retry for transient errors
   * Retries up to MAX_READ_RETRIES times with READ_RETRY_DELAY between attempts
   * 
   * @param session - Active OPC-UA session
   * @param nodesToRead - Array of nodes to read
   * @returns Array of data values
   */
  private async readWithRetry(session: ClientSession, nodesToRead: ReadValueIdOptions[]): Promise<DataValue[]> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.MAX_READ_RETRIES; attempt++) {
      try {
        const dataValues = await session.read(nodesToRead);
        
        // Check if any values have transient errors
        const hasTransientErrors = dataValues.some((dv: DataValue) => 
          !dv.statusCode.isGood() && this.isTransientError(dv.statusCode)
        );
        
        // If no transient errors, or this is the last attempt, return results
        if (!hasTransientErrors || attempt === this.MAX_READ_RETRIES) {
          if (attempt > 1) {
            this.logger.debug(`Read succeeded on attempt ${attempt}/${this.MAX_READ_RETRIES}`);
          }
          return dataValues;
        }
        
        // Log transient error and retry
        const transientCount = dataValues.filter((dv: DataValue) => 
          !dv.statusCode.isGood() && this.isTransientError(dv.statusCode)
        ).length;
        
        this.logger.warn(`Transient errors detected (${transientCount}/${dataValues.length} nodes), retrying...`, {
          attempt,
          maxAttempts: this.MAX_READ_RETRIES,
          retryDelayMs: this.READ_RETRY_DELAY
        });
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, this.READ_RETRY_DELAY));
        
      } catch (error) {
        lastError = error as Error;
        
        // If this is not the last attempt and error looks transient, retry
        if (attempt < this.MAX_READ_RETRIES) {
          this.logger.warn(`Read failed (attempt ${attempt}/${this.MAX_READ_RETRIES}), retrying...`, {
            error: lastError.message,
            retryDelayMs: this.READ_RETRY_DELAY
          });
          
          await new Promise(resolve => setTimeout(resolve, this.READ_RETRY_DELAY));
          continue;
        }
        
        // Last attempt failed, throw error
        throw lastError;
      }
    }
    
    // Should never reach here, but TypeScript needs it
    throw lastError || new Error('Read failed after all retries');
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

    // Validate data points
    if (!dataPoints || dataPoints.length === 0) {
      throw new Error(`Device ${device.name}: at least one data point is required`);
    }

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

    // Validate authentication
    if (connection.username && !connection.password) {
      this.logger.warn(
        `Device ${device.name}: username provided without password`
      );
    }
  }

  /**
   * Discover and select best matching endpoint
   * Filters by security mode, security policy, and transport profile
   * 
   * @param baseUrl - Base OPC-UA discovery URL
   * @param desiredSecurityMode - Desired security mode
   * @param desiredSecurityPolicy - Desired security policy
   * @returns Best matching endpoint or null
   */
  private async discoverAndSelectEndpoint(
    baseUrl: string,
    desiredSecurityMode: MessageSecurityMode,
    desiredSecurityPolicy: SecurityPolicy
  ): Promise<any | null> {
    try {
      // Discover all available endpoints
      // Discover endpoints using getEndpoints (OPC-UA standard method)
      const discoveryClient = OPCUAClient.create({
        endpoint_must_exist: false
      });
      await discoveryClient.connect(baseUrl);
      const allEndpoints = await discoveryClient.getEndpoints();
      await discoveryClient.disconnect();
      
      if (!allEndpoints || allEndpoints.length === 0) {
        this.logger.warn('No endpoints discovered');
        return null;
      }
      
      this.logger.debug(`Discovered ${allEndpoints.length} endpoints`);
      
      // Filter endpoints by security mode and policy
      const matchingEndpoints = allEndpoints.filter((endpoint: any) => {
        const modeMatch = endpoint.securityMode === desiredSecurityMode;
        const policyMatch = this.matchesSecurityPolicy(endpoint.securityPolicyUri, desiredSecurityPolicy);
        const transportMatch = endpoint.transportProfileUri?.includes('http://opcfoundation.org/UA-Profile/Transport/uatcp-uasc-uabinary');
        
        return modeMatch && policyMatch && transportMatch;
      });
      
      if (matchingEndpoints.length === 0) {
        this.logger.warn('No endpoints match security requirements', {
          desiredMode: MessageSecurityMode[desiredSecurityMode],
          desiredPolicy: desiredSecurityPolicy,
          availableEndpoints: allEndpoints.map((e: any) => ({
            url: e.endpointUrl,
            securityMode: MessageSecurityMode[e.securityMode],
            securityPolicy: e.securityPolicyUri
          }))
        });
        return null;
      }
      
      // Select best endpoint (prefer exact match, then first available)
      const bestEndpoint = matchingEndpoints[0];
      
      this.logger.info('Selected endpoint', {
        url: bestEndpoint.endpointUrl,
        securityMode: MessageSecurityMode[bestEndpoint.securityMode],
        securityPolicy: bestEndpoint.securityPolicyUri,
        transportProfile: bestEndpoint.transportProfileUri
      });
      
      return bestEndpoint;
      
    } catch (error) {
      this.logger.warn('Endpoint discovery failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
  
  /**
   * Check if endpoint security policy matches desired policy
   */
  private matchesSecurityPolicy(endpointPolicyUri: string | undefined, desiredPolicy: SecurityPolicy): boolean {
    if (!endpointPolicyUri) {
      return desiredPolicy === SecurityPolicy.None;
    }
    
    // Map policy URIs to SecurityPolicy enum
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

  /**
   * Connects to an OPC-UA device
   * Creates OPCUAClient, discovers endpoints, and establishes session
   * 
   * @param device - Device configuration
   * @returns OPCUASession object with client and session
   */
  protected async connectDevice(device: OPCUADeviceConfig): Promise<OPCUASession> {
    const { connection } = device;

    this.logger.info(`Connecting to OPC-UA device: ${device.name}`);
    this.logger.debug(`Endpoint: ${connection.endpointUrl}`);

    // Step 1: Discover and select best matching endpoint
    const desiredSecurityMode = this.convertSecurityMode(connection.securityMode);
    const desiredSecurityPolicy = this.convertSecurityPolicy(connection.securityPolicy);
    
    const discoveredEndpoint = await this.discoverAndSelectEndpoint(
      connection.endpointUrl,
      desiredSecurityMode,
      desiredSecurityPolicy
    );

    // Step 2: Create OPC-UA client with endpoint requirements
    const hostname = require('os').hostname();
    const client = OPCUAClient.create({
      applicationName: 'Iotistic Sensor Agent',
      applicationUri: `urn:${hostname}:Iotistic Sensor Agent`,
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
    });

    try {
      // Step 3: Connect to server (use discovered endpoint if available)
      const connectUrl = discoveredEndpoint?.endpointUrl || connection.endpointUrl;
      this.logger.info(`Attempting connection to ${connectUrl}`, {
        securityMode: MessageSecurityMode[this.convertSecurityMode(connection.securityMode)],
        securityPolicy: connection.securityPolicy
      });
      
      await client.connect(connectUrl);
      this.logger.info(`Connected to ${connectUrl}`);

      // Step 4: Create session with optional authentication
      this.logger.debug('Creating session...');
      let session: ClientSession;
      if (connection.username && connection.password) {
        session = await client.createSession({
          type: UserTokenType.UserName,
          userName: connection.username,
          password: connection.password,
        });
        this.logger.debug(`Session created with username authentication`);
      } else {
        session = await client.createSession();
        this.logger.debug(`Session created with anonymous authentication`);
      }

      this.logger.info(`Session established for device: ${device.name}`);

      const sessionWrapper: OPCUASession = {
        client,
        session,
        subscription: null,
        monitoredItems: new Map(),
        validatedNodes: new Set(),
        reconnecting: false,
        currentRetryDelay: this.MIN_RETRY_DELAY,
        consecutiveFailures: 0
      };
      
      // Store session for reconnection access
      this.sessions.set(device.name, sessionWrapper);
      
      // Setup connection event handlers for automatic reconnection
      this.setupConnectionHandlers(device, sessionWrapper);
      
      // Setup session event handlers for keep-alive monitoring
      this.setupSessionHandlers(device, sessionWrapper);

      // Validate NodeIDs before creating subscription or reads
      const { valid: validDataPoints, invalid: invalidNodeIds } = await this.validateNodeIds(
        session,
        device.dataPoints,
        device.name
      );

      // Cache validated NodeIDs
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

      // If all nodes are invalid, don't create subscription
      if (validDataPoints.length === 0) {
        throw new Error(`All NodeIDs failed validation for device ${device.name}`);
      }

      // Create subscription if enabled (real-time streaming)
      if (device.connection.useSubscription && validDataPoints.length > 0) {
        try {
          await this.createSubscription(device.name, device, sessionWrapper);
          this.logger.info(`Subscription mode enabled for ${device.name} - using real-time streaming`);
        } catch (error) {
          this.logger.error(`Failed to create subscription for ${device.name}: ${error}`);
          this.logger.warn(`Falling back to polling mode for ${device.name}`);
        }
      }

      return sessionWrapper;
    } catch (error) {
      // Clean up client if session creation failed
      try {
        await client.disconnect();
      } catch (disconnectError) {
        this.logger.debug(`Error disconnecting client during cleanup: ${disconnectError}`);
      }
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
    const delay = Math.min(
      sessionWrapper.currentRetryDelay,
      this.MAX_RETRY_DELAY
    );
    
    this.logger.info(`Scheduling reconnect for ${device.name}`, {
      reason,
      delayMs: delay,
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
    this.logger.info(`Attempting reconnect to OPC-UA device: ${device.name}`, {
      attempt: sessionWrapper.consecutiveFailures,
      maxAttempts: this.MAX_RETRY_ATTEMPTS
    });
    
    try {
      // Clean up old client/session if they exist
      await this.cleanupSession(sessionWrapper, false);
      
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
      
      this.logger.info(`Reconnected successfully to ${device.name}`);
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
      
      // Close subscription
      if (sessionWrapper.subscription) {
        await sessionWrapper.subscription.terminate();
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
    if (!sessionWrapper) {
      return;
    }

    this.logger.info(`Disconnecting OPC-UA device: ${deviceName}`);
    
    // Stop reconnection attempts
    sessionWrapper.reconnecting = false;
    
    try {
      await this.cleanupSession(sessionWrapper, true);
      this.logger.info(`Disconnected from device: ${deviceName}`);
    } catch (error) {
      this.logger.error(`Error disconnecting device ${deviceName}: ${error}`);
    } finally {
      this.sessions.delete(deviceName);
    }
  }

  /**
   * Reads data from an OPC-UA device
   * Reads all configured data points and converts to SensorDataPoint format
   * 
   * @param deviceName - Name of device to read
   * @param device - Device configuration
   * @returns Array of sensor data points
   */
  protected async readDeviceData(
    deviceName: string,
    device: OPCUADeviceConfig
  ): Promise<SensorDataPoint[]> {
    const sessionWrapper = this.sessions.get(deviceName);
    if (!sessionWrapper?.session) {
      throw new Error(`No active session for device: ${deviceName}`);
    }

    // If subscription is active, data comes via events - skip polling
    if (sessionWrapper.subscription && device.connection.useSubscription) {
      this.logger.debug(`Subscription active for ${deviceName} - skipping poll`);
      return [];
    }

    const { session } = sessionWrapper;
    const { dataPoints } = device;

    // Filter to only validated nodes
    const validDataPoints = dataPoints.filter(dp => sessionWrapper.validatedNodes.has(dp.nodeId));

    if (validDataPoints.length === 0) {
      this.logger.warn(`No valid NodeIDs to read for ${deviceName}`);
      return [];
    }

    // Build read request for validated data points only
    const nodesToRead: ReadValueIdOptions[] = validDataPoints.map((dp) => ({
      nodeId: dp.nodeId,
      attributeId: AttributeIds.Value,
    }));

    // Read all nodes with automatic retry for transient errors
    const dataValues: DataValue[] = await this.lock(deviceName, () => 
      this.readWithRetry(session, nodesToRead)
    );

    // Convert to SensorDataPoint format
    const results: SensorDataPoint[] = [];
    const timestamp = new Date().toISOString();

    for (let i = 0; i < validDataPoints.length; i++) {
      const dp = validDataPoints[i];
      const dataValue = dataValues[i];

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
          registerName: dp.name,
          value: null,
          unit: dp.unit || '',
          quality,
          qualityCode,
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
        registerName: dp.name,
        value,
        unit: dp.unit || '',
        quality: 'GOOD' as const,
      });
    }

    return results;
  }

  /**
   * Converts security mode string to OPC-UA MessageSecurityMode enum
   */
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

  /**
   * Converts security policy string to OPC-UA SecurityPolicy enum
   */
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
    this.sessions.clear();
  }
}
