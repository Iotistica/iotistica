/**
 * Fingerprint helpers for discovered devices.
 */

import crypto from 'crypto';

/** Generate Modbus fingerprint from bus identity and slave details. */
export function generateModbusFingerprint(
	busId: string,
	slaveId: number,
	deviceIdValue?: string
): string {
	const identity = deviceIdValue 
		? `${busId}:${slaveId}:${deviceIdValue}`
		: `${busId}:${slaveId}`;
  
	return crypto
		.createHash('sha256')
		.update(`modbus:${identity}`)
		.digest('hex')
		.substring(0, 32);
}

/** Generate OPC UA fingerprint from application URI. */
export function generateOPCUAFingerprint(applicationUri: string): string {
	return crypto
		.createHash('sha256')
		.update(`opcua:${applicationUri}`)
		.digest('hex')
		.substring(0, 32);
}

/** Generate CAN fingerprint from CAN ID pattern and optional manufacturer hint. */
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

/** Generate SNMP fingerprint from IP address and object identifier. */
export function generateSNMPFingerprint(
	ipAddress: string,
	sysObjectID: string
): string {
	const identity = `${ipAddress}:${sysObjectID}`;
  
	return crypto
		.createHash('sha256')
		.update(`snmp:${identity}`)
		.digest('hex')
		.substring(0, 32);
}

/** Generate MQTT fingerprint from topic path. */
export function generateMqttFingerprint(topic: string): string {
	return crypto
		.createHash('sha256')
		.update(`mqtt:${topic}`)
		.digest('hex')
		.substring(0, 32);
}

/** Generate BACnet fingerprint from IP address and device instance. */
export function generateBACnetFingerprint(
	ipAddress: string,
	deviceInstance: number
): string {
	const identity = `${ipAddress}:${deviceInstance}`;
  
	return crypto
		.createHash('sha256')
		.update(`bacnet:${identity}`)
		.digest('hex')
		.substring(0, 32);
}
