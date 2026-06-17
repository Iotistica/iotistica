import { z } from 'zod';

/**
 * BACnet Object Type enumeration (subset of most common types)
 */
export enum BACnetObjectType {
  ANALOG_INPUT = 'analog-input',
  ANALOG_OUTPUT = 'analog-output',
  ANALOG_VALUE = 'analog-value',
  BINARY_INPUT = 'binary-input',
  BINARY_OUTPUT = 'binary-output',
  BINARY_VALUE = 'binary-value',
  MULTI_STATE_INPUT = 'multi-state-input',
  MULTI_STATE_OUTPUT = 'multi-state-output',
  MULTI_STATE_VALUE = 'multi-state-value',
}

/**
 * BACnet Property identifiers (common subset)
 */
export enum BACnetProperty {
  PRESENT_VALUE = 85,
  DESCRIPTION = 28,
  UNITS = 117,
  OBJECT_NAME = 77,
  STATUS_FLAGS = 111,
  OUT_OF_SERVICE = 81,
  RELIABILITY = 103,
}

/**
 * BACnet Object Configuration Schema
 */
export const BACnetObjectSchema = z.object({
	name: z.string().min(1),
	objectType: z.nativeEnum(BACnetObjectType),
	objectInstance: z.number().min(0).max(4194303),
	propertyId: z.nativeEnum(BACnetProperty).optional().default(BACnetProperty.PRESENT_VALUE),
	unit: z.string().optional().default(''),
	pollIntervalMs: z.number().min(1000).optional().default(5000),
	enabled: z.boolean().optional().default(true),
});

export type BACnetObject = z.infer<typeof BACnetObjectSchema>;

/**
 * BACnet Device Configuration Schema
 */
export const BACnetDeviceSchema = z.object({
	name: z.string().min(1),
	/** Optional human-readable label. When set, takes priority over the protocol-discovered objectName. */
	displayName: z.string().optional(),
	ipAddress: z.string().ip(),
	port: z.number().min(1).max(65535).optional().default(47808),
	deviceInstance: z.number().min(0).max(4194303),
	enabled: z.boolean().optional().default(true),
	objects: z.array(BACnetObjectSchema).min(1),
	pollIntervalMs: z.number().min(1000).optional().default(5000), // Device-level poll interval
	maxConcurrentReads: z.number().min(1).max(10).optional().default(5),
	connectionTimeoutMs: z.number().min(1000).optional().default(5000),
	retryAttempts: z.number().min(0).max(5).optional().default(1),
	retryDelayMs: z.number().min(100).optional().default(500),
});

export type BACnetDevice = z.infer<typeof BACnetDeviceSchema>;

/**
 * BACnet Adapter Configuration Schema
 */
export const BACnetAdapterConfigSchema = z.object({
	enabled: z.boolean().optional().default(true),
	port: z.number().min(1).max(65535).optional().default(47809), // Agent port (different from device port 47808)
	devices: z.array(BACnetDeviceSchema),
	globalPollIntervalMs: z.number().min(1000).optional().default(5000),
	maxConcurrentDevices: z.number().min(1).max(20).optional().default(10),
});

export type BACnetAdapterConfig = z.infer<typeof BACnetAdapterConfigSchema>;
