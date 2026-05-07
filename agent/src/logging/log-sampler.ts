import type { LogMessage, LogLevel } from './types';

export type SamplingRates = {
	error?: number;
	warn?: number;
	info?: number;
	debug?: number;
};

/**
 * LogSampler
 * ==========
 * Stateless sampling and log-classification utilities.
 *
 * `circuitBreakerOpen` is passed per-call rather than stored so this class
 * is independently testable without wiring up the full CloudLogBackend.
 */
export class LogSampler {
	private readonly deviceUuid: string;
	private readonly rates: Required<SamplingRates>;

	constructor(deviceUuid: string, rates?: SamplingRates) {
		this.deviceUuid = deviceUuid;
		this.rates = {
			error: rates?.error ?? 1.0,
			warn:  rates?.warn  ?? 1.0,
			info:  rates?.info  ?? 1.0,
			debug: rates?.debug ?? 0.05,
		};
	}

	/**
	* Returns true if this log message should be forwarded to the cloud.
	*
	* Critical logs are never dropped. When the circuit breaker is open,
	* info logs are sampled at 10% and debug logs are dropped entirely.
	*/
	shouldSample(logMessage: LogMessage, circuitBreakerOpen: boolean): boolean {
		if (this.isCriticalLog(logMessage)) {
			return true;
		}

		const level = this.detectLogLevel(logMessage);

		if (circuitBreakerOpen) {
			switch (level) {
				case 'error': return true;
				case 'warn':  return true;
				case 'info':  return this.deterministicSample(logMessage, 0.1);
				case 'debug': return false;
			}
		}

		const rate = this.rates[level] ?? 1.0;
		return this.deterministicSample(logMessage, rate);
	}

	/**
	* Extract log level from a structured or unstructured log message.
	* Prefers the structured `level` field; falls back to regex pattern matching.
	*/
	detectLogLevel(logMessage: LogMessage): LogLevel {
		if (logMessage.level) {
			return logMessage.level;
		}

		const msg = logMessage.message.toLowerCase();

		if (/\[error\]|\[crit\]|\[alert\]|\[emerg\]|error|fatal|critical/.test(msg)) {
			return 'error';
		}
		if (/\[warn\]|warning/.test(msg)) {
			return 'warn';
		}
		if (/\[debug\]|debug|trace/.test(msg)) {
			return 'debug';
		}
		return 'info';
	}

	/**
	* Returns true if the log is critical and must never be dropped by
	* circuit-breaker shedding.
	*
	* Covers: error/warn levels, agent service logs, isSystem flag,
	* system/manager log sources.
	*/
	isCriticalLog(logMessage: LogMessage): boolean {
		const level = logMessage.level ?? this.detectLogLevel(logMessage);
		if (level === 'error' || level === 'warn') {
			return true;
		}

		if ((logMessage.serviceName || '').toLowerCase() === 'agent') {
			return true;
		}

		if (logMessage.isSystem) {
			return true;
		}

		const sourceType = logMessage.source?.type;
		return sourceType === 'system' || sourceType === 'manager';
	}

	/**
	* Fast approximate serialized size for buffer byte-budget accounting.
	* Avoids JSON.stringify on the hot path; conservative to prevent underestimating.
	*/
	estimateLogSize(logMessage: LogMessage): number {
		const messageLen = logMessage.message ? logMessage.message.length : 0;
		const serviceLen = logMessage.serviceName ? logMessage.serviceName.length : 0;
		const levelLen   = logMessage.level ? logMessage.level.length : 0;
		const fixedOverhead = 220;
		return fixedOverhead + messageLen + serviceLen + levelLen;
	}

	/**
	* Deterministic sampling based on a hash of device + service + minute bucket.
	*
	* The minute-bucket keeps the same service consistently sampled/dropped within
	* a one-minute window (better dashboard UX than purely random sampling).
	*/
	private deterministicSample(logMessage: LogMessage, rate: number): boolean {
		if (rate >= 1.0) return true;
		if (rate <= 0.0) return false;

		const minuteBucket = Math.floor(Date.now() / 60000);
		const serviceName  = logMessage.serviceName || 'unknown';
		const hashKey      = `${this.deviceUuid}:${serviceName}:${minuteBucket}`;
		const hashValue    = this.simpleHash(hashKey);
		return (hashValue % 1000) / 1000 < rate;
	}

	/** DJB2 hash — fast, good distribution, returns a positive integer. */
	private simpleHash(str: string): number {
		let hash = 5381;
		for (let i = 0; i < str.length; i++) {
			hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + char
		}
		return Math.abs(hash);
	}
}
