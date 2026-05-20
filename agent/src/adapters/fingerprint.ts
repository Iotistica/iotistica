/**
 * Fingerprint helpers for discovered devices.
 */

import crypto from 'crypto';

// Overload signatures for type safety
export function generateFingerprint(
	protocol: 'modbus',
	busId: string,
	slaveId: number,
	deviceIdValue?: string
): string;
export function generateFingerprint(protocol: 'opcua', applicationUri: string): string;
export function generateFingerprint(protocol: 'can', canIdPattern: string, manufacturerHint?: string): string;
export function generateFingerprint(protocol: 'mqtt', topic: string): string;
export function generateFingerprint(protocol: 'bacnet', ipAddress: string, deviceInstance: number): string;

/** Generate fingerprint for a discovered device protocol. */
export function generateFingerprint(protocol: string, ...args: any[]): string {
	let identity: string;

	switch (protocol) {
		case 'modbus': {
			const [busId, slaveId, deviceIdValue] = args;
			identity = deviceIdValue ? `${busId}:${slaveId}:${deviceIdValue}` : `${busId}:${slaveId}`;
			break;
		}
		case 'opcua':
			identity = args[0];
			break;
		case 'can': {
			const [canIdPattern, manufacturerHint] = args;
			identity = manufacturerHint ? `${canIdPattern}:${manufacturerHint}` : canIdPattern;
			break;
		}
		case 'mqtt':
			identity = args[0];
			break;
		case 'bacnet': {
			const [ipAddress, deviceInstance] = args;
			identity = `${ipAddress}:${deviceInstance}`;
			break;
		}
		default:
			throw new Error(`Unknown protocol: ${protocol}`);
	}

	return crypto
		.createHash('sha256')
		.update(`${protocol}:${identity}`)
		.digest('hex')
		.substring(0, 32);
}
