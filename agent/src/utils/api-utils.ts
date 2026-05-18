/**
 * Helpers for building cloud API endpoints.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

/** Returns package version or unknown. */
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


/** Returns API version from environment. */
export function getApiVersion(): string {
	return process.env.API_VERSION || 'v1';
}

/**
 * Ensures the base API URL ends with /api.
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
 * Builds a versioned or unversioned API endpoint.
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
 * Builds an endpoint scoped to a specific device UUID.
 */
export function buildAgentEndpoint(
	cloudApiEndpoint: string,
	deviceUuid: string,
	path: string
): string {
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	return buildApiEndpoint(cloudApiEndpoint, `/device/${deviceUuid}${normalizedPath}`);
}
