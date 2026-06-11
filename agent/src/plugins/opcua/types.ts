/**
 * OPC-UA Adapter Type Definitions
 * 
 * This module defines TypeScript types and Zod schemas for OPC-UA device configuration.
 * OPC-UA (OPC Unified Architecture) is a machine-to-machine communication protocol
 * for industrial automation.
 */

import { z } from 'zod';

/**
 * OPC-UA Security Mode
 * - None: No security
 * - Sign: Message signing only
 * - SignAndEncrypt: Message signing and encryption
 */
export const OPCUASecurityModeSchema = z.enum(['None', 'Sign', 'SignAndEncrypt']);
export type OPCUASecurityMode = z.infer<typeof OPCUASecurityModeSchema>;

/**
 * OPC-UA Security Policy
 * Common security policies supported by most OPC-UA servers
 */
export const OPCUASecurityPolicySchema = z.enum([
	'None',
	'Basic128Rsa15',
	'Basic256',
	'Basic256Sha256',
	'Aes128_Sha256_RsaOaep',
	'Aes256_Sha256_RsaPss'
]);
export type OPCUASecurityPolicy = z.infer<typeof OPCUASecurityPolicySchema>;

export const OPCUACertificateTrustModeSchema = z.enum(['strict', 'trust-on-first-use']);
export type OPCUACertificateTrustMode = z.infer<typeof OPCUACertificateTrustModeSchema>;

/**
 * OPC-UA Connection Configuration
 * Stored in the 'connection' JSONB field in the devices table
 */
export const OPCUAConnectionSchema = z.object({
	/** OPC-UA endpoint URL (e.g., opc.tcp://10.0.0.60:4840) */
	endpointUrl: z.string().url(),
  
	/** Username for authentication (optional) */
	username: z.string().optional(),
  
	/** Password for authentication (optional) */
	password: z.string().optional(),
  
	/** Security mode */
	securityMode: OPCUASecurityModeSchema.default('None'),
  
	/** Security policy */
	securityPolicy: OPCUASecurityPolicySchema.default('None'),

	/** How unknown server certificates are handled */
	certificateTrustMode: OPCUACertificateTrustModeSchema.default('strict'),

	/** Optional pinned SHA-1 thumbprint for the expected server certificate */
	expectedServerThumbprint: z.string().trim().toLowerCase().regex(/^[a-f0-9]{40}$/).optional(),
  
	/** Connection timeout in milliseconds */
	connectionTimeout: z.number().int().positive().default(10000),
  
	/** Session timeout in milliseconds */
	sessionTimeout: z.number().int().positive().default(60000),
  
	/** Keep-alive interval in milliseconds */
	keepAliveInterval: z.number().int().positive().default(5000),
  
	/** Enable subscription mode (real-time streaming instead of polling) */
	useSubscription: z.boolean().default(false),
  
	/** Subscription publishing interval in milliseconds (only if useSubscription=true) */
	publishingInterval: z.number().int().positive().default(1000),
  
	/** Subscription sampling interval in milliseconds (only if useSubscription=true) */
	samplingInterval: z.number().int().positive().default(500),
  
	/** Maximum monitored items per subscription (default: 100) */
	/** Many PLCs struggle with 200+ items - this auto-splits subscriptions for load distribution */
	maxMonitoredItemsPerSubscription: z.number().int().positive().default(100),
});
export type OPCUAConnection = z.infer<typeof OPCUAConnectionSchema>;

/**
 * OPC-UA Data Point Configuration
 * Stored in the 'data_points' JSONB field in the devices table
 */
export const OPCUADataPointSchema = z.object({
	/** Data point name (e.g., temperature, pressure) */
	name: z.string(),
  
	/** OPC-UA Node ID (e.g., ns=2;s=Temperature or ns=3;i=1001) */
	nodeId: z.string(),
  
	/** 
   * Explicit semantic classification (HIGHEST AUTHORITY - user intent)
   * Use this to override auto-classification when semantics cannot be inferred from type.
   * 
   * Examples where explicit classification is needed:
   * - firmware_version (UInt32) → semantic: 'metadata' (numeric but not telemetry)
   * - line1_speed_rpm (Int32) → semantic: 'metric' (numeric telemetry)
   * - alarm_active_count (UInt16) → semantic: 'metric' (numeric telemetry)
   * - max_supported_channels (UInt16) → semantic: 'metadata' (numeric config)
   * 
   * If not specified, classification uses hierarchy:
   * 1. Well-known prefixes (serverinfo_*, deviceinfo_*, metadata_*)
   * 2. OPC UA metadata (NodeClass, DataType)
   * 3. Data type (numeric = metric, non-numeric = metadata)
   */
	semantic: z.enum(['metric', 'metadata']).optional(),
  
	/** Node classification: 'metric' (device data) or 'metadata' (server info, diagnostics) */
	nodeType: z.enum(['metric', 'metadata']).default('metric'),
  
	/** Data type (inferred from OPC-UA, but can be specified) */
	dataType: z.enum(['number', 'string', 'boolean', 'object']).optional(),
  
	/** Unit of measurement (optional) */
	unit: z.string().optional(),
  
	/** Scaling factor (optional) */
	scalingFactor: z.number().optional(),
  
	/** Offset (optional) */
	offset: z.number().optional(),

	/** Device group UUID — shared by all nodes in the same profile group */
	device_uuid: z.string().optional(),

	/** Explicitly allow writes for this node. Default false keeps current read-only behavior. */
	writable: z.boolean().optional().default(false),

	/**
	 * Optional OPC UA data type hint used when writing values.
	 * If omitted, type is inferred from the value at runtime.
	 */
	writeDataType: z.enum([
		'Boolean',
		'SByte',
		'Byte',
		'Int16',
		'UInt16',
		'Int32',
		'UInt32',
		'Int64',
		'UInt64',
		'Float',
		'Double',
		'String'
	]).optional(),
});
export type OPCUADataPoint = z.infer<typeof OPCUADataPointSchema>;

/**
 * OPC-UA Device Metadata
 * Stored in the 'metadata' JSONB field in the devices table
 */
export const OPCUAMetadataSchema = z.object({
	/** Device manufacturer */
	manufacturer: z.string().optional(),
  
	/** Device model */
	model: z.string().optional(),
  
	/** Firmware version */
	firmwareVersion: z.string().optional(),
  
	/** Application URI */
	applicationUri: z.string().optional(),
  
	/** Application Name */
	applicationName: z.string().optional(),
  
	/** Custom tags for grouping/filtering */
	tags: z.array(z.string()).optional(),

	/** Optional human-readable label. When set, overrides the OPC-UA server DisplayName as the display name in payloads. */
	displayName: z.string().optional(),
});
export type OPCUAMetadata = z.infer<typeof OPCUAMetadataSchema>;

/**
 * Complete OPC-UA Device Configuration
 * Maps to a row in the devices table with protocol='opcua'
 */
export const OPCUADeviceConfigSchema = z.object({
	/** Device name (unique identifier) */
	name: z.string(),
  
	/** Protocol (must be 'opcua') */
	protocol: z.literal('opcua'),
  
	/** Whether device is enabled */
	enabled: z.boolean().default(true),
  
	/** Polling interval in milliseconds */
	pollInterval: z.number().int().positive().default(5000),
  
	/** Connection configuration */
	connection: OPCUAConnectionSchema,
  
	/** Data points to read */
	dataPoints: z.array(OPCUADataPointSchema),
  
	/** Device metadata */
	metadata: OPCUAMetadataSchema.optional(),
});
export type OPCUADeviceConfig = z.infer<typeof OPCUADeviceConfigSchema>;

/**
 * OPC-UA Adapter Configuration
 * Contains all OPC-UA devices managed by this adapter
 */
export const OPCUAAdapterConfigSchema = z.object({
	/** Array of OPC-UA devices */
	devices: z.array(OPCUADeviceConfigSchema),
  
	/** Global timeout for all operations (ms) */
	globalTimeout: z.number().int().positive().optional(),
  
	/** Maximum concurrent connections */
	maxConcurrentConnections: z.number().int().positive().default(5),
});
export type OPCUAAdapterConfig = z.infer<typeof OPCUAAdapterConfigSchema>;
