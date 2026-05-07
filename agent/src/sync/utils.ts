import { createHash } from 'crypto';
import type { AgentStateReport } from './types.js';

/**
 * Stable JSON stringify — sorts object keys recursively for deterministic output.
 *
 * Prevents false diffs caused by object key-order differences, which would otherwise
 * trigger unnecessary deployments, redundant cloud reports, or reconciliation loops.
 */
export function stableStringify(obj: any): string {
	if (obj === null || obj === undefined) {
		return JSON.stringify(obj);
	}

	if (typeof obj !== 'object') {
		return JSON.stringify(obj);
	}

	if (Array.isArray(obj)) {
		return '[' + obj.map(item => stableStringify(item)).join(',') + ']';
	}

	const sortedKeys = Object.keys(obj).sort();
	const pairs = sortedKeys
		.filter(key => obj[key] !== undefined)
		.map(key => JSON.stringify(key) + ':' + stableStringify(obj[key]));

	return '{' + pairs.join(',') + '}';
}

/**
 * SHA256 hash of any object.
 * Uses stableStringify to ensure deterministic hashing regardless of key order.
 */
export function calculateHash(obj: any): string {
	return createHash('sha256')
		.update(stableStringify(obj))
		.digest('hex');
}

/**
 * Compare two apps objects, ignoring runtime-only fields (containerId, status)
 * that change when containers are recreated but don't represent config changes.
 */
export function appsChanged(oldApps: any, newApps: any): boolean {
	const normalizeService = (service: any) => {
		const { _containerId, _status, ...configFields } = service;
		return configFields;
	};

	const normalizeApp = (app: any) => {
		if (!app?.services) return app;
		return { ...app, services: app.services.map(normalizeService) };
	};

	const normalizedOld: any = {};
	const normalizedNew: any = {};

	for (const appId in oldApps) {
		normalizedOld[appId] = normalizeApp(oldApps[appId]);
	}
	for (const appId in newApps) {
		normalizedNew[appId] = normalizeApp(newApps[appId]);
	}

	return stableStringify(normalizedOld) !== stableStringify(normalizedNew);
}

/**
 * Calculate diff between two state reports (state fields only, no metrics).
 * Returns only the fields that changed.
 */
export function calculateStateDiff(
	oldState: AgentStateReport,
	newState: AgentStateReport,
): Partial<AgentStateReport> {
	const diff: any = {};

	for (const uuid in newState) {
		const oldDevice = oldState[uuid] || {};
		const newDevice = newState[uuid];
		const deviceDiff: any = {};

		for (const key in newDevice) {
			const oldValue = (oldDevice as any)[key];
			const newValue = (newDevice as any)[key];

			if (key === 'apps') {
				if (appsChanged(oldValue || {}, newValue || {})) {
					deviceDiff[key] = newValue;
				}
			} else if (key === 'config') {
				if (stableStringify(oldValue || {}) !== stableStringify(newValue || {})) {
					deviceDiff[key] = newValue;
				}
			} else {
				if (oldValue !== newValue) {
					deviceDiff[key] = newValue;
				}
			}
		}

		if (Object.keys(deviceDiff).length > 0) {
			diff[uuid] = deviceDiff;
		}
	}

	return diff;
}
