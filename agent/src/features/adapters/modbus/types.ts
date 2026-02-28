import { z } from 'zod';

/**
 * Modbus Function Code enumeration
 */
export enum ModbusFunctionCode {
  READ_COILS = 1,
  READ_DISCRETE_INPUTS = 2,
  READ_HOLDING_REGISTERS = 3,
  READ_INPUT_REGISTERS = 4,
  WRITE_SINGLE_COIL = 5,
  WRITE_SINGLE_REGISTER = 6,
  WRITE_MULTIPLE_COILS = 15,
  WRITE_MULTIPLE_REGISTERS = 16
}

/**
 * Modbus Connection Type enumeration
 */
export enum ModbusConnectionType {
  TCP = 'tcp',
  RTU = 'rtu',
  ASCII = 'ascii'
}

/**
 * Data Type enumeration for register interpretation
 */
export enum ModbusDataType {
  INT16 = 'int16',
  UINT16 = 'uint16',
  INT32 = 'int32',
  UINT32 = 'uint32',
  FLOAT32 = 'float32',
  BOOLEAN = 'boolean',
  STRING = 'string'
}

/**
 * Byte Order for multi-register data types (32-bit)
 * Industry-standard notation for Modbus register ordering
 * 
 * For a 32-bit value across 2 registers (reg0, reg1):
 * - ABCD: Big-endian words, big-endian bytes (standard Modbus)
 * - CDAB: Little-endian words, big-endian bytes (common in many devices)
 * - BADC: Big-endian words, little-endian bytes (rare)
 * - DCBA: Little-endian words, little-endian bytes (Intel order)
 * 
 * Example: Float value 123.456 = 0x42F6E979
 * ABCD: [0x42F6, 0xE979] → reg0=0x42F6, reg1=0xE979
 * CDAB: [0xE979, 0x42F6] → reg0=0xE979, reg1=0x42F6
 * BADC: [0xF642, 0x79E9] → reg0=0xF642, reg1=0x79E9
 * DCBA: [0x79E9, 0xF642] → reg0=0x79E9, reg1=0xF642
 */
export enum ByteOrder {
  ABCD = 'ABCD', // Big-endian (most common in Modbus)
  CDAB = 'CDAB', // Word-swapped (common in inverters, meters)
  BADC = 'BADC', // Byte-swapped
  DCBA = 'DCBA'  // Little-endian (rare)
}

/**
 * Legacy Endianness enum for backward compatibility
 * Maps to ByteOrder: BIG → ABCD, LITTLE → CDAB
 * @deprecated Use ByteOrder instead
 */
export enum Endianness {
  BIG = 'big',
  LITTLE = 'little'
}

/**
 * Modbus Register Configuration Schema
 */
export const ModbusRegisterSchema = z.object({
  name: z.string().min(1),
  address: z.number().min(0).max(65535),
  functionCode: z.nativeEnum(ModbusFunctionCode),
  dataType: z.nativeEnum(ModbusDataType),
  count: z.number().min(1).max(125).optional().default(1), // For multiple registers
  byteOrder: z.nativeEnum(ByteOrder).optional().default(ByteOrder.ABCD), // For 32-bit values
  endianness: z.nativeEnum(Endianness).optional(), // Legacy - maps to byteOrder
  scale: z.number().optional().default(1), // Scaling factor
  offset: z.number().optional().default(0), // Offset value
  unit: z.string().optional().default(''), // Unit of measurement
  encoding: z.enum(['ascii', 'utf8', 'utf-8', 'latin1', 'binary']).optional().default('ascii'), // For STRING type
  description: z.string().optional().default('')
});

export type ModbusRegister = z.infer<typeof ModbusRegisterSchema>;

/**
 * Modbus Connection Configuration Schema
 */
export const ModbusConnectionSchema = z.object({
  type: z.nativeEnum(ModbusConnectionType),
  // TCP specific
  host: z.string().optional(),
  port: z.number().min(1).max(65535).optional().default(502),
  // RTU/ASCII specific
  serialPort: z.string().optional(),
  baudRate: z.number().optional().default(9600),
  dataBits: z.number().min(7).max(8).optional().default(8),
  stopBits: z.number().min(1).max(2).optional().default(1),
  parity: z.enum(['none', 'even', 'odd']).optional().default('none'),
  // Common settings
  timeout: z.number().min(100).max(30000).optional().default(5000), // milliseconds
  retryAttempts: z.number().min(0).max(10).optional().default(3),
  retryDelay: z.number().min(100).max(10000).optional().default(1000), // milliseconds
}).refine((data) => {
  // TCP connections require host
  if (data.type === ModbusConnectionType.TCP && !data.host) {
    return false;
  }
  // RTU/ASCII connections require serialPort
  if ((data.type === ModbusConnectionType.RTU || data.type === ModbusConnectionType.ASCII) && !data.serialPort) {
    return false;
  }
  return true;
}, {
  message: "TCP connections require host, RTU/ASCII connections require serialPort"
});

export type ModbusConnectionConfig = z.infer<typeof ModbusConnectionSchema>;

/**
 * Modbus Device Configuration Schema
 */
export const ModbusDeviceSchema = z.object({
  name: z.string().min(1),
  slaveId: z.number().min(1).max(247),
  connection: ModbusConnectionSchema,
  registers: z.array(ModbusRegisterSchema).min(1),
  pollInterval: z.number().min(100).max(300000).optional().default(5000), // milliseconds
  enabled: z.boolean().optional().default(true)
});

export type ModbusDevice = z.infer<typeof ModbusDeviceSchema>;

/**
 * Modbus Adapter Configuration Schema
 * Note: output config is now optional - managed by SensorsFeature
 */
export const ModbusAdapterConfigSchema = z.object({
  devices: z.array(ModbusDeviceSchema).min(1),
  output: z.object({
    socketPath: z.string().min(1),
    dataFormat: z.enum(['json', 'csv']).optional().default('json'),
    delimiter: z.string().optional().default('\n'),
    includeTimestamp: z.boolean().optional().default(true),
    includeDeviceName: z.boolean().optional().default(true)
  }).optional(), // Now optional - for backward compatibility with standalone mode
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
    enableConsole: z.boolean().optional().default(true),
    enableFile: z.boolean().optional().default(false),
    filePath: z.string().optional()
  }).optional().default({})
});

export type ModbusAdapterConfig = z.infer<typeof ModbusAdapterConfigSchema>;
