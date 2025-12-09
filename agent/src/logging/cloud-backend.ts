/**
 * Cloud Log Backend
 * ==================
 * 
 * Streams container logs to cloud API in real-time
 * 
 * Features:
 * - Streams logs via HTTP POST
 * - Local buffering during network issues
 * - Automatic reconnection with exponential backoff
 * - NDJSON format (newline-delimited JSON)
 */

import type { LogBackend, LogMessage, LogFilter } from './types';
import { LogComponents } from './types';
import { buildApiEndpoint } from '../utils/api-utils';
import type { AgentLogger } from '../logging/agent-logger';
import { RetryPolicy } from '../utils/retry-policy';
import { isRetryableNetworkError, getNetworkErrorType } from '../utils/network';
import { HttpClient, FetchHttpClient } from '../lib/http-client';

/**
 * Summary of dropped logs for analysis
 * Captures key metadata without storing full log content
 */
interface DroppedLogSummary {
	/** When logs were dropped */
	droppedAt: number;
	/** Time range of dropped logs */
	timeRange: {
		start: number;
		end: number;
	};
	/** Total logs dropped in this batch */
	totalCount: number;
	/** Breakdown by log level */
	levelCounts: {
		error: number;
		warn: number;
		info: number;
		debug: number;
	};
	/** Breakdown by service */
	serviceCounts: Record<string, number>;
	/** Sample error messages (up to 5) */
	errorSamples: Array<{
		timestamp: number;
		serviceName: string;
		message: string;
	}>;
	/** Sample warning messages (up to 5) */
	warningSamples: Array<{
		timestamp: number;
		serviceName: string;
		message: string;
	}>;
	/** Estimated bytes dropped */
	estimatedBytes: number;
	/** Reason for dropping */
	reason: 'network_failure' | 'buffer_overflow' | 'retry_exhausted';
}

/**
 * Cloud Log Backend Configuration
 */
interface CloudLogBackendConfig {
	cloudEndpoint: string;
	deviceUuid: string;
	deviceApiKey?: string;
	compression?: boolean;
	batchSize?: number;
	maxRetries?: number;
	bufferSize?: number;
	flushInterval?: number;
	reconnectInterval?: number;
	maxReconnectInterval?: number;
	// Sampling configuration (reduce log volume)
	samplingRates?: {
		error?: number;   // Default: 1.0 (100% - all errors)
		warn?: number;    // Default: 1.0 (100% - all warnings)
		info?: number;    // Default: 0.1 (10% - sample info logs)
		debug?: number;   // Default: 0.01 (1% - sample debug logs)
	};
}

export class CloudLogBackend implements LogBackend {
	private config: Required<CloudLogBackendConfig>;
	private buffer: LogMessage[] = [];
	private isStreaming: boolean = false;
	private retryCount: number = 0;
	private retryPolicy: RetryPolicy;
	private abortController?: AbortController;
	private logger?: AgentLogger;
	private flushTimer?: NodeJS.Timeout;
	private reconnectTimer?: NodeJS.Timeout;
	private samplingRates: Required<NonNullable<CloudLogBackendConfig['samplingRates']>>;
	private sampledLogCount: number = 0;
	private totalLogCount: number = 0;
	private httpClient: HttpClient;
	
	/** Circular buffer of dropped log summaries (for later analysis) */
	private droppedLogSummaries: DroppedLogSummary[] = [];
	private readonly MAX_DROPPED_SUMMARIES = 50; // Keep last 50 drop events
	
	/** Throttling for error/warning logs */
	private consecutiveFailures: number = 0;
	private lastErrorLog: number = 0;
	private lastWarningLog: number = 0;
	private errorLogThrottle: number = 30000; // Log errors max once per 30 seconds
	private warningLogThrottle: number = 30000; // Log warnings max once per 30 seconds
	
	/** Circuit breaker for cloud logging */
	private circuitBreakerOpen: boolean = false;
	private circuitBreakerOpenedAt: number = 0;
	private readonly CIRCUIT_BREAKER_THRESHOLD = 10; // Open after 10 consecutive failures
	private readonly CIRCUIT_BREAKER_RESET_MS = 60000; // Try again after 1 minute
	
	constructor(config: CloudLogBackendConfig, logger?: AgentLogger) {

		this.logger = logger;
		this.config = {
			cloudEndpoint: config.cloudEndpoint,
			deviceUuid: config.deviceUuid,
			deviceApiKey: config.deviceApiKey ?? '',
		compression: config.compression ?? true,
		batchSize: config.batchSize ?? 500, // 500 logs per batch (changed from 100)
		maxRetries: config.maxRetries ?? 3,		bufferSize: config.bufferSize ?? 256 * 1024, // 256KB
		flushInterval: config.flushInterval ?? 30000, // 30 seconds (changed from 100ms)
		reconnectInterval: config.reconnectInterval ?? 5000, // 5s
		maxReconnectInterval: config.maxReconnectInterval ?? 300000, // 5min
		samplingRates: config.samplingRates ?? { debug: 0.01, info: 0.1, warn: 1, error: 1 }, // Selective sampling (changed from all 1)
	};		// Initialize HTTP client with default headers
		this.httpClient = new FetchHttpClient({
			defaultHeaders: {
				'X-Device-API-Key': this.config.deviceApiKey
			},
			defaultTimeout: 30000 // 30 second timeout
		});
		
		// Initialize sampling rates with defaults
		this.samplingRates = {
			error: config.samplingRates?.error ?? 1.0,   // 100% - all errors
			warn: config.samplingRates?.warn ?? 1.0,     // 100% - all warnings
			info: config.samplingRates?.info ?? 0.1,     // 10% - sample info logs
			debug: config.samplingRates?.debug ?? 0.01,  // 1% - sample debug logs
		};
		
		// Initialize retry policy
		this.retryPolicy = new RetryPolicy(
			{
				maxAttempts: 5,
				baseDelayMs: 5000,
				maxDelayMs: 300000,
				backoffMultiplier: 2,
				
				onRetry: (attempt, error, remaining) => {
					// Use logger with component to avoid recursive logging
					const now = Date.now();
					if (now - this.lastWarningLog > this.warningLogThrottle) {
						const errorType = getNetworkErrorType(error);
						this.logger?.warnSync(`Temporary network error (attempt ${attempt}/${attempt + remaining}): ${errorType}`, {
							component: LogComponents.cloudSync
						});
						this.lastWarningLog = now;
					}
				},
				
				onFailure: (error, attempts) => {
					// Use logger with component to avoid recursive logging
					this.consecutiveFailures++;
					
					// Open circuit breaker if too many failures
					if (this.consecutiveFailures >= this.CIRCUIT_BREAKER_THRESHOLD && !this.circuitBreakerOpen) {
						this.circuitBreakerOpen = true;
						this.circuitBreakerOpenedAt = Date.now();
						this.logger?.errorSync(`Circuit breaker OPEN - too many failures (${this.consecutiveFailures}). Will retry in ${this.CIRCUIT_BREAKER_RESET_MS / 1000}s`, undefined, {
							component: LogComponents.cloudSync
						});
					}
					
					const now = Date.now();
					if (now - this.lastErrorLog > this.errorLogThrottle) {
						const errorType = getNetworkErrorType(error);
						this.logger?.errorSync(`Persistent network error: ${errorType} (failures: ${this.consecutiveFailures})`, undefined, {
							component: LogComponents.cloudSync
						});
						this.lastErrorLog = now;
					}
				}
			},
			{ isRetryable: isRetryableNetworkError }
		);
	}
	
	async initialize(): Promise<void> {
		this.logger?.infoSync('Initializing Cloud Log Backend...', { component: LogComponents.logs });
		this.logger?.infoSync('Configuration loaded', { 
			component: LogComponents.logs,
			endpoint: this.config.cloudEndpoint,
			device: this.config.deviceUuid,
			compression: this.config.compression,
			samplingRates: {
				error: `${(this.samplingRates.error * 100).toFixed(0)}%`,
				warn: `${(this.samplingRates.warn * 100).toFixed(0)}%`,
				info: `${(this.samplingRates.info * 100).toFixed(0)}%`,
				debug: `${(this.samplingRates.debug * 100).toFixed(1)}%`
			}
		});
		
		// Start streaming
		await this.connect();
		
		this.logger?.infoSync('Cloud Log Backend initialized', { component: LogComponents.logs });
	
	}
	
	async log(logMessage: LogMessage): Promise<void> {
		this.totalLogCount++;
		
		// Apply sampling based on log level
		if (!this.shouldSample(logMessage)) {
			// Log sampled out
			return;
		}
		
		this.sampledLogCount++;
		
		// Add to buffer
		this.buffer.push(logMessage);
		
		this.logger?.debugSync('Buffered log', { 
			component: LogComponents.logs,
			bufferSize: this.buffer.length,
			samplingRatio: `${this.sampledLogCount}/${this.totalLogCount}`,
			service: logMessage.serviceName,
			messagePreview: logMessage.message.substring(0, 50)
		});
		
		// Schedule flush if not already scheduled
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => {
				this.flush();
			}, this.config.flushInterval);
		}
		
		// Check buffer size (prevent memory overflow)
		const bufferBytes = JSON.stringify(this.buffer).length;
		if (bufferBytes > this.config.bufferSize) {
			this.logger?.warnSync('Log buffer full, forcing flush', { 
				component: LogComponents.logs,
				bufferSizeKB: Math.round(bufferBytes / 1024)
			});
			await this.flush();
		}
	}
	
	async getLogs(filter?: LogFilter): Promise<LogMessage[]> {
		// CloudLogBackend doesn't store logs locally (they're streamed to cloud)
		// Return empty array
		return [];
	}
	
	async getLogCount(): Promise<number> {
		return 0;
	}
	
	async cleanup(olderThanMs: number): Promise<number> {
		// CloudLogBackend doesn't store logs locally
		return 0;
	}
	
	async stop(): Promise<void> {
		this.logger?.infoSync('Stopping Cloud Log Backend...', { component: LogComponents.logs });
		
		// Flush remaining logs
		await this.flush();
		
		// Stop streaming
		this.isStreaming = false;
		
		// Cancel any pending operations
		if (this.abortController) {
			this.abortController.abort();
		}
		
		// Clear timers
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
		}
		
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
		}
		
		this.logger?.infoSync('Cloud Log Backend stopped', { component: LogComponents.logs });
	}
	
	// ============================================================================
	// PRIVATE METHODS
	// ============================================================================
	
	private async connect(): Promise<void> {
		if (this.isStreaming) {
			return;
		}
		
		this.isStreaming = true;
		this.logger?.infoSync('Connecting to cloud log stream...', { component: LogComponents.logs });
	}
	
	private async flush(): Promise<void> {
		// Clear flush timer
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		
		// Nothing to flush
		if (this.buffer.length === 0) {
			return;
		}
		
		// Check circuit breaker
		if (this.circuitBreakerOpen) {
			const now = Date.now();
			const timeSinceOpen = now - this.circuitBreakerOpenedAt;
			
			if (timeSinceOpen < this.CIRCUIT_BREAKER_RESET_MS) {
				// Circuit still open - silently accumulate logs
				return;
			} else {
				// Try to close circuit breaker
				this.logger?.infoSync('Circuit breaker attempting reset...', {
					component: LogComponents.cloudSync
				});
				this.circuitBreakerOpen = false;
				this.consecutiveFailures = 0;
			}
		}
		
		// Split buffer into smaller batches if too large
		const batchSize = this.config.batchSize;
		const batches: LogMessage[][] = [];
		
		for (let i = 0; i < this.buffer.length; i += batchSize) {
			batches.push(this.buffer.slice(i, i + batchSize));
		}
		
		this.logger?.debugSync('Attempting to flush logs to cloud', { 
			component: LogComponents.logs,
			totalLogs: this.buffer.length,
			batches: batches.length,
			batchSize
		});
		
		// Clear buffer immediately to prevent duplicate sends
		this.buffer = [];
		
		// Send batches sequentially
		const failedLogs: LogMessage[] = [];
		
		for (const batch of batches) {
			try {
				// Use retry policy for network resilience
				await this.retryPolicy.execute(() => this.sendLogs(batch));
				
				// Reset retry counters on success
				this.retryCount = 0;
				const wasCircuitOpen = this.circuitBreakerOpen;
				this.consecutiveFailures = 0;
				this.circuitBreakerOpen = false;
				this.retryPolicy.reset();
				
				// Only log recovery if circuit breaker was open (avoid spam)
				if (wasCircuitOpen) {
					this.logger?.infoSync(`Circuit breaker CLOSED - connection restored (sent ${batch.length} logs)`, {
						component: LogComponents.cloudSync
					});
				}
			} catch (error) {
				// All retries exhausted - create summary before dropping
				if (this.retryPolicy.hasExhaustedRetries()) {
					const summary = this.createDroppedLogSummary(batch, 'retry_exhausted');
					this.storeDroppedLogSummary(summary);
					
					this.logger?.warnSync('Dropping logs due to persistent network errors', { 
						component: LogComponents.logs,
						droppedLogs: batch.length,
						consecutiveFailures: this.retryPolicy.getConsecutiveFailures()
					});
					continue; // Drop these logs
				}
				
				// Keep logs for retry (shouldn't happen with current policy, but safety net)
				failedLogs.push(...batch);
				this.retryCount++;
			}
		}
		
		// Re-add failed logs to buffer (at the beginning) but limit total buffer size
		if (failedLogs.length > 0) {
			const maxBufferLogs = 500; // Maximum logs to keep in buffer
			const logsToKeep = failedLogs.slice(-maxBufferLogs); // Keep most recent
			
			if (failedLogs.length > maxBufferLogs) {
				const droppedLogs = failedLogs.slice(0, failedLogs.length - maxBufferLogs);
				const summary = this.createDroppedLogSummary(droppedLogs, 'buffer_overflow');
				this.storeDroppedLogSummary(summary);
				
				this.logger?.warnSync('Buffer overflow: dropping oldest logs', { 
					component: LogComponents.logs,
					droppedLogs: droppedLogs.length
				});
			}
			
			this.buffer = [...logsToKeep, ...this.buffer];
			
			// Schedule reconnect with exponential backoff
			this.scheduleReconnect();
		} else {
			// Connection recovered - send dropped log summaries if any
			await this.sendDroppedLogSummaries();
		}
	}
	
	private async sendLogs(logs: LogMessage[]): Promise<void> {
		const endpoint = buildApiEndpoint(this.config.cloudEndpoint, `/device/${this.config.deviceUuid}/logs`);
		
		// Convert to NDJSON (newline-delimited JSON)
		const ndjson = logs.map(log => JSON.stringify(log)).join('\n') + '\n';
		
		// Send to cloud using HTTP client (compression handled automatically)
		const response = await this.httpClient.post(endpoint, ndjson, {
			headers: {
				'Content-Type': 'application/x-ndjson'
			},
			compress: this.config.compression
		});
		
		if (!response.ok) {
			// Use console.error to avoid recursive logging
			const now = Date.now();
			if (now - this.lastErrorLog > this.errorLogThrottle) {
				console.error(`[CloudLogBackend] HTTP ${response.status}: ${response.statusText}`);
				this.lastErrorLog = now;
			}
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}
	}
	
	private scheduleReconnect(): void {
		if (this.reconnectTimer) {
			return; // Already scheduled
		}
		
		// Calculate backoff delay (exponential)
		const delay = Math.min(
			this.config.reconnectInterval * Math.pow(2, this.retryCount - 1),
			this.config.maxReconnectInterval
		);
		
		this.logger?.infoSync('Retrying log upload', { 
			component: LogComponents.logs,
			retryInSeconds: Math.round(delay / 1000),
			retryCount: this.retryCount
		});
		
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.flush();
		}, delay);
	}
	
	/**
	 * Determine if a log should be sampled (kept) or discarded
	 * Based on log level and configured sampling rates
	 */
	private shouldSample(logMessage: LogMessage): boolean {
		// Detect log level from message content
		const level = this.detectLogLevel(logMessage);
		
		// Get sampling rate for this level
		const rate = this.samplingRates[level] ?? 1.0;
		
		// Sample: keep if random value is less than rate
		// Examples:
		//   rate = 1.0 → always keep (100%)
		//   rate = 0.1 → keep 10%
		//   rate = 0.01 → keep 1%
		return Math.random() < rate;
	}
	
	/**
	 * Detect log level from message content
	 * Uses regex patterns similar to dashboard display logic
	 */
	private detectLogLevel(logMessage: LogMessage): 'error' | 'warn' | 'info' | 'debug' {
		const msg = logMessage.message.toLowerCase();
		
		// Error patterns
		if (/\[error\]|\[crit\]|\[alert\]|\[emerg\]|error|fatal|critical/.test(msg)) {
			return 'error';
		}
		
		// Warning patterns
		if (/\[warn\]|warning/.test(msg)) {
			return 'warn';
		}
		
		// Debug patterns
		if (/\[debug\]|debug|trace/.test(msg)) {
			return 'debug';
		}
		
		// Default to info
		return 'info';
	}
	
	/**
	 * Create summary of dropped logs for later analysis
	 * Captures key metadata without storing full log content
	 */
	private createDroppedLogSummary(
		logs: LogMessage[], 
		reason: DroppedLogSummary['reason']
	): DroppedLogSummary {
		const levelCounts = { error: 0, warn: 0, info: 0, debug: 0 };
		const serviceCounts: Record<string, number> = {};
		const errorSamples: DroppedLogSummary['errorSamples'] = [];
		const warningSamples: DroppedLogSummary['warningSamples'] = [];
		
		let minTimestamp = Infinity;
		let maxTimestamp = 0;
		
		// Analyze logs
		for (const log of logs) {
			// Track time range
			minTimestamp = Math.min(minTimestamp, log.timestamp);
			maxTimestamp = Math.max(maxTimestamp, log.timestamp);
			
			// Count by level
			const level = log.level || this.detectLogLevel(log);
			levelCounts[level]++;
			
			// Count by service
			const serviceName = log.serviceName || 'unknown';
			serviceCounts[serviceName] = (serviceCounts[serviceName] || 0) + 1;
			
			// Collect error samples (first 5)
			if (level === 'error' && errorSamples.length < 5) {
				errorSamples.push({
					timestamp: log.timestamp,
					serviceName: serviceName,
					message: log.message.substring(0, 200) // Truncate long messages
				});
			}
			
			// Collect warning samples (first 5)
			if (level === 'warn' && warningSamples.length < 5) {
				warningSamples.push({
					timestamp: log.timestamp,
					serviceName: serviceName,
					message: log.message.substring(0, 200)
				});
			}
		}
		
		// Estimate bytes
		const estimatedBytes = JSON.stringify(logs).length;
		
		return {
			droppedAt: Date.now(),
			timeRange: {
				start: minTimestamp === Infinity ? Date.now() : minTimestamp,
				end: maxTimestamp || Date.now()
			},
			totalCount: logs.length,
			levelCounts,
			serviceCounts,
			errorSamples,
			warningSamples,
			estimatedBytes,
			reason
		};
	}
	
	/**
	 * Store dropped log summary in circular buffer
	 * Keeps last N summaries for analysis
	 */
	private storeDroppedLogSummary(summary: DroppedLogSummary): void {
		this.droppedLogSummaries.push(summary);
		
		// Maintain circular buffer size
		if (this.droppedLogSummaries.length > this.MAX_DROPPED_SUMMARIES) {
			this.droppedLogSummaries.shift(); // Remove oldest
		}
		
		// Use logger with component to avoid recursive logging (throttled)
		const now = Date.now();
		if (now - this.lastWarningLog > this.warningLogThrottle) {
			this.logger?.warnSync(`Dropped ${summary.totalCount} logs (${summary.reason}): ${summary.levelCounts.error} errors, ${summary.levelCounts.warn} warnings, ~${Math.round(summary.estimatedBytes / 1024)}KB`, {
				component: LogComponents.cloudSync
			});
			this.lastWarningLog = now;
		}
	}
	
	/**
	 * Send dropped log summaries to cloud when connection recovers
	 * This allows analysis of what was lost during outages
	 * 
	 * NOTE: Endpoint not implemented in API yet - commenting out to avoid 404 spam
	 */
	private async sendDroppedLogSummaries(): Promise<void> {
		// TODO: Implement /device/{uuid}/logs/dropped-summaries endpoint in API
		// For now, just clear summaries to avoid memory buildup
		if (this.droppedLogSummaries.length > 0) {
			this.logger?.debugSync('Dropped log summaries tracked (endpoint not implemented)', {
				component: LogComponents.logs,
				summaryCount: this.droppedLogSummaries.length,
				totalDroppedLogs: this.droppedLogSummaries.reduce((sum, s) => sum + s.totalCount, 0)
			});
			this.droppedLogSummaries = [];
		}
		return;
		
		/* COMMENTED OUT - Endpoint not implemented
		if (this.droppedLogSummaries.length === 0) {
			return;
		}
		
		const endpoint = buildApiEndpoint(
			this.config.cloudEndpoint, 
			`/device/${this.config.deviceUuid}/logs/dropped-summaries`
		);
		
		try {
			const response = await this.httpClient.post(endpoint, {
				summaries: this.droppedLogSummaries,
				deviceUuid: this.config.deviceUuid,
				reportedAt: Date.now()
			});
			
			if (response.ok) {
				this.logger?.infoSync('Sent dropped log summaries to cloud', {
					component: LogComponents.logs,
					summaryCount: this.droppedLogSummaries.length,
					totalDroppedLogs: this.droppedLogSummaries.reduce((sum, s) => sum + s.totalCount, 0)
				});
				
				// Clear summaries after successful send
				this.droppedLogSummaries = [];
			}
		} catch (error) {
			// Silently fail - summaries will be sent on next recovery
			this.logger?.debugSync('Failed to send dropped log summaries (will retry)', {
				component: LogComponents.logs,
				error: error instanceof Error ? error.message : String(error)
			});
		}
		*/
	}
}
