/**
 * API UTILITIES - Cloud API Endpoint Handling
 * ===========================================
 * 
 * Provides utilities for normalizing and building cloud API endpoints.
 * Handles the case where K8s nginx ingress rewrites /api to /api/v1.
 * 
 * Usage:
 * ```typescript
 * import { buildApiEndpoint } from './utils/api-utils';
 * 
 * const endpoint = buildApiEndpoint(baseUrl, '/device/state');
 * // http://7f05d0d2.localhost/api => http://7f05d0d2.localhost/api/v1/device/state
 * // http://localhost:4002 => http://localhost:4002/api/v1/device/state
 * ```
 */

import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Get package version from package.json
 * @returns Package version string or "unknown" if not found
 */
export function getPackageVersion(): string {
	try {
		const packageJsonPath = join(process.cwd(), "package.json");
		const content = readFileSync(packageJsonPath, "utf-8");
		const packageJson = JSON.parse(content);
		return packageJson.version || "unknown";
	} catch (_error) {
		return "unknown";
	}
}


/**
 * Get API version from environment variable
 * Defaults to 'v1' if not specified
 */
export function getApiVersion(): string {
	return process.env.API_VERSION || 'v1';
}

/**
 * Normalize cloud API endpoint
 * 
 * Handles two scenarios:
 * 1. K8s ingress with /api path (e.g., http://7f05d0d2.localhost/api)
 * 2. Direct API endpoint without path (e.g., http://localhost:4002)
 * 
 * @param cloudApiEndpoint - Base cloud API URL from environment
 * @returns Normalized endpoint ending with /api (without /v1)
 * 
 * @example
 * normalizeApiEndpoint('http://7f05d0d2.localhost/api')
 * // => 'http://7f05d0d2.localhost/api'
 * 
 * @example
 * normalizeApiEndpoint('http://localhost:4002')
 * // => 'http://localhost:4002/api'
 */
export function normalizeApiEndpoint(cloudApiEndpoint: string): string {
	// Remove trailing slashes
	const trimmed = cloudApiEndpoint.replace(/\/+$/, '');
	
	// If endpoint already includes /api, use as-is
	if (trimmed.endsWith('/api')) {
		return trimmed;
	}
	
	// Otherwise append /api
	return `${trimmed}/api`;
}

/**
 * Build full API endpoint with path
 * 
 * Combines normalized base URL with API version and path.
 * 
 * @param cloudApiEndpoint - Base cloud API URL from environment
 * @param path - API path (should start with /)
 * @param includeVersion - Whether to include API version (default: true)
 * @returns Full API endpoint URL
 * 
 * @example
 * buildApiEndpoint('http://7f05d0d2.localhost/api', '/device/state')
 * // => 'http://7f05d0d2.localhost/api/v1/device/state'
 * 
 * @example
 * buildApiEndpoint('http://localhost:4002', '/device/123/jobs/next')
 * // => 'http://localhost:4002/api/v1/device/123/jobs/next'
 * 
 * @example
 * buildApiEndpoint('http://localhost:4002', '/device/state', false)
 * // => 'http://localhost:4002/api/device/state'
 */
export function buildApiEndpoint(
	cloudApiEndpoint: string,
	path: string,
	includeVersion: boolean = true
): string {
	const normalized = normalizeApiEndpoint(cloudApiEndpoint);
	const version = includeVersion ? `/${getApiVersion()}` : '';
	
	// Ensure path starts with /
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	
	return `${normalized}${version}${normalizedPath}`;
}

/**
 * Build device-specific endpoint
 * 
 * Convenience method for building device-specific API endpoints.
 * 
 * @param cloudApiEndpoint - Base cloud API URL from environment
 * @param deviceUuid - Device UUID
 * @param path - Path after /device/{uuid} (should start with /)
 * @returns Full device API endpoint URL
 * 
 * @example
 * buildDeviceEndpoint('http://localhost:4002', 'abc-123', '/state')
 * // => 'http://localhost:4002/api/v1/device/abc-123/state'
 * 
 * @example
 * buildDeviceEndpoint('http://7f05d0d2.localhost/api', 'abc-123', '/jobs/next')
 * // => 'http://7f05d0d2.localhost/api/v1/device/abc-123/jobs/next'
 */
export function buildAgentEndpoint(
	cloudApiEndpoint: string,
	deviceUuid: string,
	path: string
): string {
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	return buildApiEndpoint(cloudApiEndpoint, `/device/${deviceUuid}${normalizedPath}`);
}
