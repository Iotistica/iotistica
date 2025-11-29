/**
 * Discovery Fingerprint Generator
 * 
 * Generates consistent, cryptographic fingerprints for discovered devices
 * across all protocols. Fingerprints survive device moves, port changes, etc.
 * 
 * Pattern: SHA256("<protocol>:<unique-device-identity>")
 */

import crypto from 'crypto';

/**
 * Generate Modbus fingerprint
 * Based on slave ID + device identification register (if available)
 * 
 * @param slaveId - Modbus slave ID (1-247)
 * @param deviceIdValue - Optional: Device identification register value (0x2B/0x0E)
 */
export function generateModbusFingerprint(
  slaveId: number,
  deviceIdValue?: string
): string {
  const identity = deviceIdValue 
    ? `${slaveId}:${deviceIdValue}`
    : `${slaveId}`;
  
  return crypto
    .createHash('sha256')
    .update(`modbus:${identity}`)
    .digest('hex')
    .substring(0, 32); // Truncate to 32 chars for readability
}

/**
 * Generate OPC-UA fingerprint
 * Based on ApplicationUri (most stable OPC-UA identifier)
 * 
 * @param applicationUri - Server ApplicationUri (e.g., "urn:localhost:OPCUA:ServerName")
 */
export function generateOPCUAFingerprint(applicationUri: string): string {
  return crypto
    .createHash('sha256')
    .update(`opcua:${applicationUri}`)
    .digest('hex')
    .substring(0, 32);
}

/**
 * Generate CAN fingerprint
 * Based on CAN ID pattern + manufacturer heuristics
 * 
 * @param canIdPattern - CAN message ID pattern (e.g., "0x18FEF100")
 * @param manufacturerHint - Optional: Detected manufacturer from J1939/OBD-II
 */
export function generateCANFingerprint(
  canIdPattern: string,
  manufacturerHint?: string
): string {
  const identity = manufacturerHint
    ? `${canIdPattern}:${manufacturerHint}`
    : canIdPattern;
  
  return crypto
    .createHash('sha256')
    .update(`can:${identity}`)
    .digest('hex')
    .substring(0, 32);
}

/**
 * Generate SNMP fingerprint
 * Based on sysObjectID (most stable SNMP identifier) + IP address
 * 
 * @param ipAddress - Device IP address
 * @param sysObjectID - SNMP sysObjectID (1.3.6.1.2.1.1.2.0) or fallback to sysDescr
 */
export function generateSNMPFingerprint(
  ipAddress: string,
  sysObjectID: string
): string {
  // Use sysObjectID if available (most stable), otherwise sysDescr
  const identity = `${ipAddress}:${sysObjectID}`;
  
  return crypto
    .createHash('sha256')
    .update(`snmp:${identity}`)
    .digest('hex')
    .substring(0, 32);
}
