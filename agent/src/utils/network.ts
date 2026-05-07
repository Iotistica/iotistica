/**
 * Network error classification utilities
 * Used for retry decision making across the agent
 */

import os from 'os';

function ipv4ToInt(ipv4: string): number | null {
	const parts = ipv4.split('.');
	if (parts.length !== 4) {
		return null;
	}

	let value = 0;
	for (const part of parts) {
		const octet = Number(part);
		if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
			return null;
		}
		value = (value << 8) | octet;
	}

	return value >>> 0;
}

function intToIpv4(value: number): string {
	return [
		(value >>> 24) & 255,
		(value >>> 16) & 255,
		(value >>> 8) & 255,
		value & 255,
	].join('.');
}

function subnetFromAddressAndMask(address: string, netmask: string): {
	networkAddress: string;
	subnetMaskLength: number;
	numHosts: number;
} | null {
	const ipInt = ipv4ToInt(address);
	const maskInt = ipv4ToInt(netmask);
	if (ipInt === null || maskInt === null) {
		return null;
	}

	const invertedMask = (~maskInt) >>> 0;
	if (((invertedMask + 1) & invertedMask) !== 0) {
		return null;
	}

	const subnetMaskLength = maskInt.toString(2).replace(/0/g, '').length;
	const networkAddressInt = ipInt & maskInt;
	const numHosts = invertedMask > 1 ? invertedMask - 1 : 0;

	return {
		networkAddress: intToIpv4(networkAddressInt >>> 0),
		subnetMaskLength,
		numHosts,
	};
}

/**
 * DNS resolution errors
 */
export function isDnsError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	
	// Check for Node.js DNS error codes
	if ('cause' in error && error.cause && typeof error.cause === 'object') {
		const cause = error.cause as { code?: string };
		if (cause.code === 'ENOTFOUND' || cause.code === 'EAI_AGAIN') {
			return true;
		}
	}
	
	// Check error message
	const msg = error.message.toLowerCase();
	return msg.includes('getaddrinfo') && 
	(msg.includes('enotfound') || msg.includes('eai_again'));
}

/**
 * Connection refused (service down/unreachable)
 */
export function isConnectionRefused(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	
	if ('cause' in error && error.cause && typeof error.cause === 'object') {
		const cause = error.cause as { code?: string };
		if (cause.code === 'ECONNREFUSED') {
			return true;
		}
	}
	
	return error.message.toLowerCase().includes('econnrefused');
}

/**
 * Timeout errors
 */
export function isTimeout(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	
	if ('cause' in error && error.cause && typeof error.cause === 'object') {
		const cause = error.cause as { code?: string };
		if (cause.code === 'ETIMEDOUT' || cause.code === 'ECONNRESET') {
			return true;
		}
	}
	
	return error.message.toLowerCase().includes('timeout');
}

/**
 * Network unreachable
 */
export function isNetworkUnreachable(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	
	if ('cause' in error && error.cause && typeof error.cause === 'object') {
		const cause = error.cause as { code?: string };
		if (cause.code === 'ENETUNREACH' || cause.code === 'EHOSTUNREACH') {
			return true;
		}
	}
	
	const msg = error.message.toLowerCase();
	return msg.includes('network unreachable') || msg.includes('host unreachable');
}

/**
 * Check if error is ANY retryable network error
 */
export function isRetryableNetworkError(error: unknown): boolean {
	return isDnsError(error) || 
	isConnectionRefused(error) || 
	isTimeout(error) ||
	isNetworkUnreachable(error);
}

/**
 * Get human-readable error type
 */
export function getNetworkErrorType(error: unknown): string {
	if (isDnsError(error)) return 'DNS_ERROR';
	if (isConnectionRefused(error)) return 'CONNECTION_REFUSED';
	if (isTimeout(error)) return 'TIMEOUT';
	if (isNetworkUnreachable(error)) return 'NETWORK_UNREACHABLE';
	return 'UNKNOWN';
}



export function autoDetectLocalSubnets(): string[] {
	const ifaces = os.networkInterfaces();
	const ranges: string[] = [];

	for (const name of Object.keys(ifaces)) {
		for (const iface of ifaces[name] || []) {
			if (iface.family === 'IPv4' && !iface.internal) {
				const subnet = subnetFromAddressAndMask(iface.address, iface.netmask);
				if (!subnet) {
					continue;
				}
				// avoid host-only / docker internal
				if (subnet.numHosts > 10) {
					ranges.push(`${subnet.networkAddress}/${subnet.subnetMaskLength}`);
				}
			}
		}
	}

	return ranges;
}


