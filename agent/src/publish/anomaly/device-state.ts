import type { Protocol } from '../../plugins/protocol.js';

export type CanonicalDeviceState = 'running' | 'idle' | 'fault' | 'unknown';

const RUNNING_TOKENS = new Set([
	'running', 'run', 'active', 'on', 'started', 'start', 'enabled', 'enable',
	'operational', 'operate', 'ready', 'online', 'normal', 'ok', 'true', '1'
]);

const IDLE_TOKENS = new Set([
	'idle', 'standby', 'paused', 'pause', 'stopped', 'stop', 'off', 'inactive',
	'sleep', 'sleeping', 'waiting', 'hold', 'false', '0'
]);

const FAULT_TOKENS = new Set([
	'fault', 'failed', 'failure', 'error', 'alarm', 'trip', 'tripped', 'shutdown',
	'disabled', 'offline', 'critical', 'bad', 'uncertain', 'warn', 'warning', '2', '3'
]);

const UNKNOWN_TOKENS = new Set(['unknown', 'na', 'n/a', 'none', 'null', 'undefined', '-1']);

/**
 * Normalize protocol-specific operational state values into canonical states.
 */
export function normalizeDeviceState(protocol: Protocol | undefined, raw: unknown): CanonicalDeviceState {
	if (raw === null || raw === undefined) {
		return fallbackStateForProtocol(protocol);
	}

	if (typeof raw === 'boolean') {
		return raw ? 'running' : 'idle';
	}

	if (typeof raw === 'number') {
		return normalizeNumericState(protocol, raw);
	}

	if (typeof raw === 'string') {
		return normalizeStringState(protocol, raw);
	}

	if (typeof raw === 'object') {
		const objectState = extractStateField(raw as Record<string, unknown>);
		if (objectState !== undefined) {
			return normalizeDeviceState(protocol, objectState);
		}
	}

	return fallbackStateForProtocol(protocol);
}

/**
 * Best-effort extraction of raw device state from protocol payloads.
 */
export function extractRawDeviceState(payload: unknown): unknown {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}

	const obj = payload as Record<string, unknown>;
	const direct = extractStateField(obj);
	if (direct !== undefined) {
		return direct;
	}

	// Common nested envelopes from endpoint adapters
	const candidates = [obj.data, obj.payload, obj.reading, obj.readings, obj.status];
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			for (const item of candidate) {
				const state = extractRawDeviceState(item);
				if (state !== undefined) return state;
			}
		} else {
			const state = extractRawDeviceState(candidate);
			if (state !== undefined) return state;
		}
	}

	return undefined;
}

function normalizeNumericState(protocol: Protocol | undefined, value: number): CanonicalDeviceState {
	// Standardized defaults (also covers many Modbus/BACnet enum patterns)
	if (value === 0) return 'idle';
	if (value === 1) return 'running';
	if (value >= 2) return 'fault';

	// Protocol fallback
	return fallbackStateForProtocol(protocol);
}

function normalizeStringState(protocol: Protocol | undefined, value: string): CanonicalDeviceState {
	const normalized = value.trim().toLowerCase();
	if (!normalized) {
		return fallbackStateForProtocol(protocol);
	}

	if (RUNNING_TOKENS.has(normalized)) return 'running';
	if (IDLE_TOKENS.has(normalized)) return 'idle';
	if (FAULT_TOKENS.has(normalized)) return 'fault';
	if (UNKNOWN_TOKENS.has(normalized)) return 'unknown';

	// Protocol-specific aliases
	if (protocol === 'bacnet') {
		if (normalized === 'in alarm' || normalized === 'fault detected') return 'fault';
		if (normalized === 'offnormal') return 'fault';
	}
	if (protocol === 'opcua') {
		if (normalized.includes('bad') || normalized.includes('uncertain')) return 'fault';
		if (normalized.includes('good')) return 'running';
	}
	if (protocol === 'mqtt') {
		if (normalized === 'connected') return 'running';
		if (normalized === 'disconnected') return 'idle';
	}

	return fallbackStateForProtocol(protocol);
}

function extractStateField(obj: Record<string, unknown>): unknown {
	const stateKeys = [
		'deviceState', 'device_state', 'operationalState', 'operational_state',
		'state', 'status', 'mode', 'runState', 'run_state',
		'isRunning', 'running', 'fault', 'error', 'alarm', 'health'
	];

	for (const key of stateKeys) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			return obj[key];
		}
	}

	return undefined;
}

function fallbackStateForProtocol(protocol: Protocol | undefined): CanonicalDeviceState {
	// System metrics are usually emitted while the agent is operational.
	if (protocol === 'system') {
		return 'running';
	}
	return 'unknown';
}
