/**
 * Network error classification utilities
 * Used for retry decision making across the agent
 */

import os from 'os';
import ip from 'ip';

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
        const subnet = ip.subnet(iface.address, iface.netmask);
        // avoid host-only / docker internal
        if (subnet.numHosts > 10) {
          ranges.push(`${subnet.networkAddress}/${subnet.subnetMaskLength}`);
        }
      }
    }
  }

  return ranges;
}

