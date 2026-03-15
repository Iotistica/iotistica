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
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

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
	reason: 'network_failure' | 'buffer_overflow' | 'retry_exhausted' | 'storage_budget';
}

/**
 * Cloud Log Backend Configuration
 */
interface CloudLogBackendConfig {
	cloudEndpoint: string;
	deviceUuid: string;
	deviceApiKey?: string;
	httpClient?: HttpClient; // Optional: shared HTTP client for connection pooling
	compression?: boolean;
	batchSize?: number;
	maxRetries?: number;
	bufferSize?: number;
	flushInterval?: number;
	reconnectInterval?: number;
	maxReconnectInterval?: number;
	// Disk-backed spool configuration (survives restarts/power loss)
	spoolPath?: string; // Path to spool directory (e.g., /var/lib/agent/log-spool)
	maxSpoolSizeMb?: number; // Max spool file size before rotation (default: 50MB)
	maxTotalSpoolSizeMb?: number; // Max total size across all spool segment files (default: 200MB)
	maxLogStorageMb?: number; // Hard cap across RAM+disk logging data (default: 256MB)
	// Sampling configuration (reduce log volume)
	samplingRates?: {
		error?: number;   // Default: 1.0 (100% - all errors)
		warn?: number;    // Default: 1.0 (100% - all warnings)
		info?: number;    // Default: 0.1 (10% - sample info logs)
		debug?: number;   // Default: 0.01 (1% - sample debug logs)
	};
}

/**
 * Batch metadata for ACK tracking (durability guarantee)
 */
interface LogBatch {
	batchId: string;          // Unique batch ID (UUID v4)
	logs: LogMessage[];       // Log messages in this batch
	createdAt: number;        // When batch was created
	attempts: number;         // Number of send attempts
	approxBytes?: number;     // Approximate serialized size for budget accounting
}

/**
 * ACK cursor state (tracks what's been successfully sent)
 */
interface AckCursor {
	lastAckBatchId?: string;  // Highest monotonic batch ID confirmed by server
	lastAckTime: number;      // Last successful ACK timestamp
}

export class CloudLogBackend implements LogBackend {
	private config: Required<Omit<CloudLogBackendConfig, 'httpClient'>> & { httpClient?: HttpClient };
	private buffer: LogMessage[] = [];
	private isStreaming: boolean = false;
	private retryCount: number = 0;
	private retryPolicy: RetryPolicy;
	private abortController?: AbortController;
	// private logger?: AgentLogger; // REMOVED - causes infinite recursion
	private flushTimer?: NodeJS.Timeout;
	private reconnectTimer?: NodeJS.Timeout;
	private samplingRates: Required<NonNullable<CloudLogBackendConfig['samplingRates']>>;
	private sampledLogCount: number = 0;
	private totalLogCount: number = 0;
	private httpClient: HttpClient;
	
	/** Adaptive batch sizing for self-adjusting to API limits */
	private adaptiveBatchSize: number = 50; // Start conservative
	private adaptiveMaxBytes: number = 5 * 1024 * 1024; // Start at 5MB
	private readonly MIN_BATCH_SIZE = 10;
	private readonly MAX_BATCH_SIZE = 200;
	private readonly MIN_BATCH_BYTES = 1 * 1024 * 1024; // 1MB
	private readonly MAX_BATCH_BYTES = 20 * 1024 * 1024; // 20MB
	private consecutiveSuccesses: number = 0;
	
	/** Incremental buffer byte tracking (avoids O(n) JSON.stringify on every log) */
	private bufferBytes: number = 0;
	
	/** Flush concurrency guard (prevents overlapping flushes) */
	private flushing: boolean = false;
	
	/** Throttle buffer full warnings (max 1 per 10 seconds) */
	private lastBufferFullWarning: number = 0;
	private readonly BUFFER_WARNING_THROTTLE_MS = 10000; // 10 seconds
	
	/** Hard cap on buffer size during circuit breaker (prevent OOM during prolonged outages) */
	private readonly MAX_OFFLINE_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB max during outages
	
	/** Disk-backed spool for surviving restarts/power loss */
	private spoolPath?: string;
	private spoolFilePath?: string;
	private spoolCursorPath?: string;  // ACK cursor file (tracks successful sends)
	private maxSpoolSize: number = 50 * 1024 * 1024; // 50MB default
	private maxTotalSpoolSize: number = 200 * 1024 * 1024; // 200MB default
	private maxLogStorageSize: number = 256 * 1024 * 1024; // 256MB default (RAM+disk)
	private spoolWriteChunks: string[] = [];
	private spoolWriteBufferBytes: number = 0;
	private spoolWriteTimer?: NodeJS.Timeout;
	private spoolWriteFlushPromise?: Promise<void>;
	private spoolActiveBytes: number = 0;
	private spoolActiveSizeKnown: boolean = false;
	private readonly SPOOL_WRITE_FLUSH_MS = 1000; // 1s write coalescing window
	private readonly SPOOL_WRITE_FLUSH_BYTES = 64 * 1024; // 64KB threshold
	
	/** Batch tracking for ACK-based durability */
	private pendingBatches: Map<string, LogBatch> = new Map(); // batchId -> batch
	private pendingBatchesBytes: number = 0;
	private nextBatchId: number = 0; // Monotonic counter for batch IDs
	
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
	
	/** Metrics tracking (for Prometheus-style observability) */
	private totalLogsDropped: number = 0; // Counter: cloudlog_dropped_total
	private totalBatchesAttempted: number = 0; // Counter: cloudlog_batches_attempted_total
	private totalBatchesAcked: number = 0; // Counter: cloudlog_batches_acked_total
	private totalBatchesFailed: number = 0; // Counter: cloudlog_batches_failed_total
	private lastFlushAttemptAt?: number;
	private lastFlushSuccessAt?: number;
	private lastFlushError?: string;
	
	constructor(config: CloudLogBackendConfig, logger?: AgentLogger) {
		// this.logger = logger; // REMOVED - causes infinite recursion
		this.config = {
			cloudEndpoint: config.cloudEndpoint,
			deviceUuid: config.deviceUuid,
			deviceApiKey: config.deviceApiKey ?? '',
		compression: config.compression ?? true,
		batchSize: config.batchSize ?? 100, // 100 logs per batch (reduced from 500 to prevent payload too large)
		maxRetries: config.maxRetries ?? 3,		bufferSize: config.bufferSize ?? 2 * 1024 * 1024, // 2MB - absorbs container startup bursts (~2000-5000 logs)
		flushInterval: config.flushInterval ?? 30000, // 30 seconds (changed from 100ms)
		reconnectInterval: config.reconnectInterval ?? 5000, // 5s
		maxReconnectInterval: config.maxReconnectInterval ?? 300000, // 5min
		spoolPath: config.spoolPath ?? '', // Empty string if not provided
		maxSpoolSizeMb: config.maxSpoolSizeMb ?? 50,
		maxTotalSpoolSizeMb: config.maxTotalSpoolSizeMb ?? 200,
		maxLogStorageMb: config.maxLogStorageMb ?? 256,
		samplingRates: config.samplingRates ?? { debug: 0.05, info: 1, warn: 1, error: 1 }, // All info/warn/error, sample 5% debug
	};		
		// Initialize disk-backed spool (if configured)
		if (this.config.spoolPath) {
			this.spoolPath = this.config.spoolPath;
			this.spoolFilePath = path.join(this.spoolPath, 'buffer.ndjson');
			this.spoolCursorPath = path.join(this.spoolPath, 'cursor.json');
			this.maxSpoolSize = this.config.maxSpoolSizeMb * 1024 * 1024;
			this.maxTotalSpoolSize = this.config.maxTotalSpoolSizeMb * 1024 * 1024;
			
			// Note: Spool directory creation deferred to initialize() to avoid blocking constructor
		}
		
	// For localhost/development, disable TLS verification
	const isLocalhost = this.config.cloudEndpoint.includes('localhost') || 
	                     this.config.cloudEndpoint.includes('127.0.0.1');
	
	// Use shared HTTP client if provided, otherwise create dedicated instance
	if (config.httpClient) {
		this.httpClient = config.httpClient;
	} else {
		this.httpClient = new FetchHttpClient({
			defaultHeaders: {
				'X-Device-API-Key': this.config.deviceApiKey
			},
			defaultTimeout: 30000, // 30 second timeout
			rejectUnauthorized: !isLocalhost // Allow self-signed certs for localhost
		});
	}
	
	// Initialize sampling rates with defaults
	this.samplingRates = {
			error: config.samplingRates?.error ?? 1.0,   // 100% - all errors
			warn: config.samplingRates?.warn ?? 1.0,     // 100% - all warnings
			info: config.samplingRates?.info ?? 1.0,     // 100% - all info logs (critical for container lifecycle)
			debug: config.samplingRates?.debug ?? 0.05,  // 5% - sample debug logs
		};
		
		// Initialize retry policy
		this.retryPolicy = new RetryPolicy(
			{
				maxAttempts: 5,
				baseDelayMs: 5000,
				maxDelayMs: 300000,
				backoffMultiplier: 2,
				
				onRetry: (attempt, error, remaining) => {
					// Use process.stderr.write for hot-path performance (no async formatting)
					const now = Date.now();
					if (now - this.lastWarningLog > this.warningLogThrottle) {
						const errorType = getNetworkErrorType(error);
						process.stderr.write(`[CloudLog] Temporary network error (attempt ${attempt}/${attempt + remaining}): ${errorType}\n`);
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
						// CRITICAL: Use process.stderr.write for hot-path performance (no async formatting, safer during memory pressure)
						process.stderr.write(`[CloudLog] Circuit breaker OPEN - too many failures (${this.consecutiveFailures}). Will retry in ${this.CIRCUIT_BREAKER_RESET_MS / 1000}s\n`);
					}
					
					const now = Date.now();
					if (now - this.lastErrorLog > this.errorLogThrottle) {
						const errorType = getNetworkErrorType(error);
						// CRITICAL: Use process.stderr.write for hot-path performance (no async formatting, safer during memory pressure)
						process.stderr.write(`[CloudLog] Persistent network error: ${errorType} (failures: ${this.consecutiveFailures})\n`);
						this.lastErrorLog = now;
					}
				}
			},
			{ isRetryable: isRetryableNetworkError }
		);
	}
	
	async initialize(): Promise<void> {
		// Create spool directory if needed (async to avoid blocking)
		if (this.spoolPath) {
			try {
				await fsp.mkdir(this.spoolPath, { recursive: true });
			} catch (error) {
				console.error(`[CloudLog] Failed to create spool directory: ${error}`);
				this.spoolPath = undefined;
				this.spoolFilePath = undefined;
				this.spoolCursorPath = undefined;
			}
		}
		
		// Replay spooled logs from previous session (if spool exists)
		if (this.spoolPath) {
			await this.replaySpooledLogs();
			await this.enforceSpoolTotalSizeCap();
		}
		
		// Start streaming
		await this.connect();
		
	
	}

	/**
	 * Trigger an immediate flush attempt.
	 * Used when another subsystem has concrete evidence that connectivity recovered.
	 */
	public triggerFlush(reason: string = 'manual'): void {
		if (this.buffer.length === 0 && this.pendingBatches.size === 0) {
			return;
		}

		console.log(`[CloudLogBackend] Triggering flush (${reason})`);
		void this.flush().catch((error) => {
			this.lastFlushError = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[CloudLogBackend] Triggered flush failed: ${this.lastFlushError}\n`);
			if (this.buffer.length > 0 || this.pendingBatches.size > 0) {
				this.scheduleReconnect();
			}
		});
	}
	
	async log(logMessage: LogMessage): Promise<void> {
		this.totalLogCount++;
		
		// Apply sampling based on log level
		if (!this.shouldSample(logMessage)) {
			// Log sampled out
			return;
		}
		
		this.sampledLogCount++;
		
		// HARD SAFETY: If cloud is down, cap memory aggressively (prevent OOM)
		if (this.circuitBreakerOpen && this.bufferBytes > this.MAX_OFFLINE_BUFFER_BYTES) {
			// Warn operators once (throttled to prevent spam)
			const now = Date.now();
			if (now - this.lastWarningLog > this.warningLogThrottle) {
				process.stderr.write('[CloudLog] Offline buffer cap reached – dropping info/debug logs\n');
				this.lastWarningLog = now;
			}

			// Keep critical logs under pressure: warn/error + agent/system/manager logs.
			if (!this.isCriticalLog(logMessage)) {
				return;
			}
		}
		
		// Hot path: use lightweight size estimate (avoid JSON.stringify per log).
		const logSize = this.estimateLogSize(logMessage);
		this.buffer.push(logMessage);
		this.bufferBytes += logSize;
		
		// this.logger?.debugSync - REMOVED (too verbose + prevents infinite recursion)
		
		// Schedule flush if not already scheduled
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => {
				void this.flush().catch((error) => {
					this.lastFlushError = error instanceof Error ? error.message : String(error);
					process.stderr.write(`[CloudLog] Flush timer execution failed: ${this.lastFlushError}\n`);
					// Ensure we don't get stuck if a timer-triggered flush throws.
					if (this.buffer.length > 0 || this.pendingBatches.size > 0) {
						this.scheduleReconnect();
					}
				});
			}, this.config.flushInterval);
		}
		
		// Check buffer size (prevent memory overflow)
		if (this.bufferBytes > this.config.bufferSize) {
			// Throttle warnings to prevent log spam (max 1 per 10 seconds)
			const now = Date.now();
			if (now - this.lastBufferFullWarning > this.BUFFER_WARNING_THROTTLE_MS) {
				process.stderr.write(`[CloudLog] Log buffer full, forcing flush (${Math.round(this.bufferBytes / 1024)} KB)\n`);
				this.lastBufferFullWarning = now;
			}
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
	
	/**
	 * Get current metrics state (for Prometheus-style /metrics endpoint)
	 * 
	 * Metrics expose internal state for machine consumption:
	 * - cloudlog_buffer_bytes (Gauge): Current buffer size in bytes
	 * - cloudlog_buffer_logs (Gauge): Current number of logs in buffer
	 * - cloudlog_pending_batches (Gauge): Number of batches awaiting ACK
	 * - cloudlog_circuit_open (Gauge): Circuit breaker state (1=open, 0=closed)
	 * - cloudlog_dropped_total (Counter): Total logs dropped since startup
	 * - cloudlog_batches_attempted_total (Counter): Total batch send attempts
	 * - cloudlog_batches_acked_total (Counter): Total successful ACKs
	 * - cloudlog_batches_failed_total (Counter): Total failed batches
	 * - cloudlog_adaptive_batch_size (Gauge): Current adaptive batch size limit
	 * - cloudlog_adaptive_batch_bytes (Gauge): Current adaptive batch byte limit
	 * - cloudlog_consecutive_failures (Gauge): Current failure streak
	 * 
	 * Example Prometheus exposition format:
	 * ```
	 * # HELP cloudlog_buffer_bytes Current buffer size in bytes
	 * # TYPE cloudlog_buffer_bytes gauge
	 * cloudlog_buffer_bytes{device="abc-123"} 524288
	 * 
	 * # HELP cloudlog_circuit_open Circuit breaker state (1=open, 0=closed)
	 * # TYPE cloudlog_circuit_open gauge
	 * cloudlog_circuit_open{device="abc-123"} 0
	 * ```
	 */
	getMetrics(): {
		// Gauges (current state)
		bufferBytes: number;
		bufferLogs: number;
		pendingBatches: number;
		circuitOpen: number; // 1=open, 0=closed
		adaptiveBatchSize: number;
		adaptiveBatchBytes: number;
		consecutiveFailures: number;
		// Counters (cumulative totals)
		droppedTotal: number;
		batchesAttemptedTotal: number;
		batchesAckedTotal: number;
		batchesFailedTotal: number;
		lastFlushAttemptAt?: string;
		lastFlushSuccessAt?: string;
		lastFlushError?: string;
		// Metadata
		deviceUuid: string;
	} {
		return {
			// Gauges
			bufferBytes: this.bufferBytes,
			bufferLogs: this.buffer.length,
			pendingBatches: this.pendingBatches.size,
			circuitOpen: this.circuitBreakerOpen ? 1 : 0,
			adaptiveBatchSize: Math.floor(this.adaptiveBatchSize),
			adaptiveBatchBytes: Math.floor(this.adaptiveMaxBytes),
			consecutiveFailures: this.consecutiveFailures,
			// Counters
			droppedTotal: this.totalLogsDropped,
			batchesAttemptedTotal: this.totalBatchesAttempted,
			batchesAckedTotal: this.totalBatchesAcked,
			batchesFailedTotal: this.totalBatchesFailed,
			...(this.lastFlushAttemptAt ? { lastFlushAttemptAt: new Date(this.lastFlushAttemptAt).toISOString() } : {}),
			...(this.lastFlushSuccessAt ? { lastFlushSuccessAt: new Date(this.lastFlushSuccessAt).toISOString() } : {}),
			...(this.lastFlushError ? { lastFlushError: this.lastFlushError } : {}),
			// Metadata
			deviceUuid: this.config.deviceUuid
		};
	}
	
	async stop(): Promise<void> {
		// this.logger?.infoSync - REMOVED to prevent infinite recursion
		console.log('[CloudSync] Stopping Cloud Log Backend...');
		
		// Flush remaining logs
		await this.flush();
		await this.flushSpoolWriteBuffer();
		
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
		if (this.spoolWriteTimer) {
			clearTimeout(this.spoolWriteTimer);
			this.spoolWriteTimer = undefined;
		}
		
		// this.logger?.infoSync - REMOVED to prevent infinite recursion
		console.log('[CloudSync] Cloud Log Backend stopped');
	}
	
	// ============================================================================
	// PRIVATE METHODS
	// ============================================================================
	
	private async connect(): Promise<void> {
		if (this.isStreaming) {
			return;
		}
		
		this.isStreaming = true;
	}
	
	private async flush(): Promise<void> {
		// Concurrency guard: prevent overlapping flushes
		if (this.flushing) {
			return;
		}
		
		this.flushing = true;
		
		try {
			this.lastFlushAttemptAt = Date.now();
			// Clear flush timer
			if (this.flushTimer) {
				clearTimeout(this.flushTimer);
				this.flushTimer = undefined;
			}
			
			// Nothing to flush
			if (this.buffer.length === 0 && this.pendingBatches.size === 0) {
				return;
			}
		
		// Check circuit breaker
		if (this.circuitBreakerOpen) {
			const now = Date.now();
			const timeSinceOpen = now - this.circuitBreakerOpenedAt;
			
			if (timeSinceOpen < this.CIRCUIT_BREAKER_RESET_MS) {
				// Circuit still open - shed non-critical buffered logs only.
				if (this.buffer.length > 0) {
					const kept: LogMessage[] = [];
					const dropped: LogMessage[] = [];

					for (const log of this.buffer) {
						if (this.isCriticalLog(log)) {
							kept.push(log);
						} else {
							dropped.push(log);
						}
					}

					if (dropped.length > 0) {
						const summary = this.createDroppedLogSummary(dropped, 'network_failure');
						this.storeDroppedLogSummary(summary);
						this.totalLogsDropped += dropped.length;
					}

					this.buffer = kept;
					this.bufferBytes = 0;
					for (const log of kept) {
						this.bufferBytes += this.estimateLogSize(log);
					}
				}
				return;
			} else {
				// Try to close circuit breaker
				// CRITICAL: Use console.log to prevent recursive logging
				console.log('[CloudLog] Circuit breaker attempting reset...');
				this.circuitBreakerOpen = false;
				this.consecutiveFailures = 0;
			}
		}
		
		// Split new buffer into smaller batches if too large
		// Use ADAPTIVE sizing that learns from failures (TCP congestion control style)
		// - On error: Cut batch size by 50% (multiplicative decrease)
		// - On success: Grow batch size by 10% (additive increase)
		const maxBatchSize = Math.floor(this.adaptiveBatchSize);
		this.totalBatchesAttempted++;
		const maxBatchBytes = Math.floor(this.adaptiveMaxBytes);
		const logBatches: LogBatch[] = [];
		const totalLogsToFlush = this.buffer.length; // Store before clearing
		
		let currentBatch: LogMessage[] = [];
		let currentBatchBytes = 0;
		
		for (const log of this.buffer) {
			// Estimate log size (JSON serialization + newline)
			const logSize = JSON.stringify(log).length + 1;
			
			// Check if adding this log would exceed adaptive limits
			const wouldExceedSize = currentBatchBytes + logSize > maxBatchBytes;
			const wouldExceedCount = currentBatch.length >= maxBatchSize;
			
			if ((wouldExceedSize || wouldExceedCount) && currentBatch.length > 0) {
				// Create batch with unique ID
				const batchId = this.generateBatchId();
				logBatches.push({
					batchId,
					logs: currentBatch,
					createdAt: Date.now(),
					attempts: 0
				});
				currentBatch = [];
				currentBatchBytes = 0;
			}
			
			currentBatch.push(log);
			currentBatchBytes += logSize;
		}
		
		// Add final batch
		if (currentBatch.length > 0) {
			const batchId = this.generateBatchId();
			logBatches.push({
				batchId,
				logs: currentBatch,
				createdAt: Date.now(),
				attempts: 0
			});
		}
		
		if (logBatches.length > 0) {
			// CRITICAL: Don't clear buffer until ACK received
			// Move logs to pending batches for tracking
			for (const logBatch of logBatches) {
				this.pendingBatches.set(logBatch.batchId, logBatch);
			}

			// Clear in-memory buffer (now tracked in pendingBatches)
			this.buffer = [];
			this.bufferBytes = 0;

			// Write to disk spool before sending (survives crashes/power loss)
			if (this.spoolFilePath) {
				await this.writeToSpool(logBatches);
			}
		}

		const batchesToSend = logBatches.length > 0
			? logBatches
			: Array.from(this.pendingBatches.values());

		// Send batches sequentially with ACK tracking
		const batchesWithRetry: string[] = []; // Track batches that need retry
		
		for (const logBatch of batchesToSend) {
			logBatch.attempts++;
			
			try {
				// Use retry policy for network resilience
				const ack = await this.retryPolicy.execute(() => this.sendLogBatch(logBatch));
				
				// Verify ACK matches batch ID (idempotency check)
				if (ack.batchId !== logBatch.batchId) {
					process.stderr.write(`[CloudLog] ACK mismatch: sent ${logBatch.batchId}, received ${ack.batchId}\n`);
					batchesWithRetry.push(logBatch.batchId);
					continue;
				}
				
				// SUCCESS: Remove from pending batches
				this.totalBatchesAcked++;
				this.pendingBatches.delete(logBatch.batchId);
				
				// Update ACK cursor (for spool pruning)
				await this.updateAckCursor(logBatch.batchId);
				
				// Increase batch size gradually (additive increase)
				this.consecutiveSuccesses++;
				
				// Grow by 10% every 3 consecutive successes
				if (this.consecutiveSuccesses >= 3) {
					const oldSize = this.adaptiveBatchSize;
					const oldBytes = this.adaptiveMaxBytes;
					
					this.adaptiveBatchSize = Math.min(
						this.adaptiveBatchSize * 1.1,
						this.MAX_BATCH_SIZE
					);
					this.adaptiveMaxBytes = Math.min(
						this.adaptiveMaxBytes * 1.1,
						this.MAX_BATCH_BYTES
					);
					
					this.consecutiveSuccesses = 0;
					
					// console.log(`[CloudLog] Adaptive growth: ${Math.floor(oldSize)}→${Math.floor(this.adaptiveBatchSize)} logs, ${(oldBytes/1024/1024).toFixed(1)}→${(this.adaptiveMaxBytes/1024/1024).toFixed(1)}MB`);
				}
				
				// Reset retry counters on success
				this.retryCount = 0;
				this.lastFlushError = undefined;
				this.lastFlushSuccessAt = Date.now();
				const wasCircuitOpen = this.circuitBreakerOpen;
				this.consecutiveFailures = 0;
				this.circuitBreakerOpen = false;
				this.retryPolicy.reset();
				
				// Log only circuit breaker state transitions (not every batch in steady state)
				if (wasCircuitOpen) {
					console.log(`[CloudLog] Circuit breaker CLOSED - connection restored (ACKed batch ${logBatch.batchId})`);
				}
			} catch (error) {
				// FAILURE: Cut batch size in half (multiplicative decrease)
				const oldSize = this.adaptiveBatchSize;
				const oldBytes = this.adaptiveMaxBytes;
				
				this.adaptiveBatchSize = Math.max(
					this.adaptiveBatchSize * 0.5,
					this.MIN_BATCH_SIZE
				);
				this.adaptiveMaxBytes = Math.max(
					this.adaptiveMaxBytes * 0.5,
					this.MIN_BATCH_BYTES
				);
				
				this.consecutiveSuccesses = 0; // Reset growth counter
				
				process.stderr.write(`[CloudLog] Adaptive decrease due to error: ${Math.floor(oldSize)}→${Math.floor(this.adaptiveBatchSize)} logs, ${(oldBytes/1024/1024).toFixed(1)}→${(this.adaptiveMaxBytes/1024/1024).toFixed(1)}MB\n`);
				
				// Drop batch if retries exhausted or too many attempts
				if (this.retryPolicy.hasExhaustedRetries() || logBatch.attempts >= 10) {
					const summary = this.createDroppedLogSummary(logBatch.logs, 'retry_exhausted');
					this.totalBatchesFailed++;
					this.totalLogsDropped += logBatch.logs.length;
					this.storeDroppedLogSummary(summary);
					
					// Remove from pending (give up)
					this.pendingBatches.delete(logBatch.batchId);
					
					process.stderr.write(`[CloudLog] Dropping batch ${logBatch.batchId} (${logBatch.logs.length} logs) after ${logBatch.attempts} attempts (retry exhaustion)\n`);
					continue;
				}
				
				// Keep batch for retry (still in pendingBatches)
				batchesWithRetry.push(logBatch.batchId);
				this.retryCount++;
				this.lastFlushError = error instanceof Error ? error.message : String(error);
			}
		}
		
		// Prune spool based on ACK cursor (remove successfully sent batches)
		if (this.spoolFilePath && this.pendingBatches.size === 0) {
			// All batches ACKed - safe to clear spool
			await this.clearSpool();
		} else if (this.spoolFilePath) {
			// Partial success - prune ACKed batches from spool
			await this.pruneSpoolByAcks();
		}
		
		// Schedule retry for failed batches
		if (batchesWithRetry.length > 0) {
			console.log(`[CloudLog] Scheduling retry for ${batchesWithRetry.length} batches`);
			this.scheduleReconnect();
		}
		} catch (error) {
			this.lastFlushError = error instanceof Error ? error.message : String(error);
			process.stderr.write(`[CloudLog] Flush failed: ${this.lastFlushError}\n`);

			// If there is still buffered or pending data, ensure retry gets scheduled.
			if (this.buffer.length > 0 || this.pendingBatches.size > 0) {
				this.scheduleReconnect();
			}
		} finally {
			// Always reset flushing flag (even if errors occur)
			this.flushing = false;
		}
	}
	
	private async sendLogBatch(logBatch: LogBatch): Promise<{ batchId: string; accepted: boolean }> {
		const endpoint = buildApiEndpoint(this.config.cloudEndpoint, `/device/${this.config.deviceUuid}/logs`);
		
		// Convert to NDJSON (newline-delimited JSON)
		const ndjson = logBatch.logs.map(log => JSON.stringify(log)).join('\n') + '\n';
		
		// Compression disabled: Envoy Gateway auto-decompresses and corrupts payloads
		// Only compress if payload is large enough to benefit (CPU > bandwidth on edge devices)
		const shouldCompress = this.config.compression && ndjson.length > 2048;
		
		// Send to cloud using HTTP client with batch ID header for idempotency
		// CRITICAL: Add X-Device-API-Key per-request (shared client doesn't have it in defaultHeaders)
		const response = await this.httpClient.post(endpoint, ndjson, {
			headers: {
				'Content-Type': 'application/x-ndjson',
				'X-Device-API-Key': this.config.deviceApiKey, // Required for device authentication
				'X-Batch-Id': logBatch.batchId,  // Server can detect duplicates
				'X-Batch-Attempt': logBatch.attempts.toString()
			},
			compress: shouldCompress
		});
		
		if (!response.ok) {
			// Use process.stderr.write for hot-path performance (no async formatting)
			const now = Date.now();
			if (now - this.lastErrorLog > this.errorLogThrottle) {
				process.stderr.write(`[CloudLog] HTTP ${response.status}: ${response.statusText}\n`);
				this.lastErrorLog = now;
			}
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}
		
		// Parse ACK response (server MUST return batch ID)
		const ack = await response.json() as { batchId: string; accepted: boolean };
		return ack;
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
		
		console.info('[CloudLog] Retrying log upload', {
			retryInSeconds: Math.round(delay / 1000),
			retryCount: this.retryCount
		});
		
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.flush().catch((error) => {
				this.lastFlushError = error instanceof Error ? error.message : String(error);
				process.stderr.write(`[CloudLog] Reconnect flush failed: ${this.lastFlushError}\n`);
				if (this.buffer.length > 0 || this.pendingBatches.size > 0) {
					this.scheduleReconnect();
				}
			});
		}, delay);
	}
	
	/**
	 * Determine if a log should be sampled (kept) or discarded
	 * Based on log level and configured sampling rates
	 */
	private shouldSample(logMessage: LogMessage): boolean {
		if (this.isCriticalLog(logMessage)) {
			return true;
		}

		// Detect log level from message content
		const level = this.detectLogLevel(logMessage);
		
		// Circuit breaker: aggressive sampling during outages (prevents memory growth)
		// Explicit degradation strategy for predictability
		if (this.circuitBreakerOpen) {
			switch (level) {
				case 'error': return true;                                      // 100% - critical signals
				case 'warn':  return true;                                      // 100% - keep warnings during outage
				case 'info':  return this.deterministicSample(logMessage, 0.1); // 10% - heavy sampling
				case 'debug': return false;                                     // 0% - drop entirely
			}
		}
		
		// Get sampling rate for this level
		const rate = this.samplingRates[level] ?? 1.0;
		
		// Use deterministic sampling for consistent dashboard behavior
		// Same logs consistently appear/disappear (better UX)
		return this.deterministicSample(logMessage, rate);
	}
	
	/**
	 * Deterministic sampling based on hash of device+service+time
	 * Same service will consistently be sampled or not (better dashboard UX)
	 * 
	 * @param logMessage Log message to sample
	 * @param rate Sampling rate (0.0 to 1.0)
	 * @returns true if log should be kept
	 */
	private deterministicSample(logMessage: LogMessage, rate: number): boolean {
		// Always keep if rate is 100%
		if (rate >= 1.0) return true;
		
		// Always drop if rate is 0%
		if (rate <= 0.0) return false;
		
		// Hash key: deviceUuid + serviceName + minute bucket
		// Minute bucket ensures sampling changes over time (not stuck forever)
		const minuteBucket = Math.floor(Date.now() / 60000);
		const serviceName = logMessage.serviceName || 'unknown';
		const hashKey = `${this.config.deviceUuid}:${serviceName}:${minuteBucket}`;
		
		// Simple DJB2 hash (fast, good distribution)
		const hashValue = this.simpleHash(hashKey);
		
		// Convert hash to 0-1 range and compare with rate
		// Same hash always produces same result within same minute
		return (hashValue % 1000) / 1000 < rate;
	}
	
	/**
	 * Simple DJB2 hash function (fast, good distribution)
	 * Returns positive integer
	 */
	private simpleHash(str: string): number {
		let hash = 5381;
		for (let i = 0; i < str.length; i++) {
			hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + char
		}
		return Math.abs(hash);
	}

	/**
	 * Fast approximate serialized size for buffer accounting.
	 * Avoids JSON.stringify in the hot path while staying close enough
	 * for flush threshold decisions.
	 */
	private estimateLogSize(logMessage: LogMessage): number {
		const messageLen = logMessage.message ? logMessage.message.length : 0;
		const serviceLen = logMessage.serviceName ? logMessage.serviceName.length : 0;
		const levelLen = logMessage.level ? logMessage.level.length : 0;

		// Approximate fixed JSON envelope + scalar fields + newline.
		// Keep this conservative to avoid underestimating and overfilling buffer.
		const fixedOverhead = 220;
		return fixedOverhead + messageLen + serviceLen + levelLen;
	}
	
	/**
	 * Detect log level from message content
	 * Prefers structured log.level field, falls back to regex patterns
	 */
	private detectLogLevel(logMessage: LogMessage): 'error' | 'warn' | 'info' | 'debug' {
		// PREFER: Use structured log.level if available (fast, reliable)
		if (logMessage.level) {
			return logMessage.level;
		}
		
		// FALLBACK: Regex parsing (CPU expensive, error-prone)
		// Only used for logs without structured level field
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
	 * Critical logs are never dropped by circuit-breaker shedding.
	 */
	private isCriticalLog(logMessage: LogMessage): boolean {
		const level = logMessage.level ?? this.detectLogLevel(logMessage);
		if (level === 'error' || level === 'warn') {
			return true;
		}

		const serviceName = (logMessage.serviceName || '').toLowerCase();
		if (serviceName === 'agent') {
			return true;
		}

		if (logMessage.isSystem) {
			return true;
		}

		const sourceType = logMessage.source?.type;
		return sourceType === 'system' || sourceType === 'manager';
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
		
		// Use process.stderr.write for hot-path performance (throttled)
		const now = Date.now();
		if (now - this.lastWarningLog > this.warningLogThrottle) {
			process.stderr.write(`[CloudLog] Dropped ${summary.totalCount} logs (${summary.reason}): ${summary.levelCounts.error} errors, ${summary.levelCounts.warn} warnings, ~${Math.round(summary.estimatedBytes / 1024)}KB\n`);
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
			console.debug('[CloudLog] Dropped log summaries tracked (endpoint not implemented)', {
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
				console.info('[CloudLog] Sent dropped log summaries to cloud', {
					summaryCount: this.droppedLogSummaries.length,
					totalDroppedLogs: this.droppedLogSummaries.reduce((sum, s) => sum + s.totalCount, 0)
				});
				// Clear summaries after successful send
				this.droppedLogSummaries = [];
			}
		} catch (error) {
			// Silently fail - summaries will be sent on next recovery
			console.debug('[CloudLog] Failed to send dropped log summaries (will retry)', {
				error: error instanceof Error ? error.message : String(error)
			});
		}
		*/
	}
	
	/**
	 * Write log batches to disk spool (survives process restarts/power loss)
	 * Format: One batch per line (JSON-encoded LogBatch)
	 * 
	 * ASYNC: Non-blocking writes prevent event loop stalls on slow flash storage
	 */
	private async writeToSpool(batches: LogBatch[]): Promise<void> {
		if (!this.spoolFilePath) return;
		
		try {
			// Write batches as JSON lines (one batch per line)
			const batchLines = batches
				.map(batch => JSON.stringify(batch))
				.join('\n') + '\n';

			// Queue writes in-memory to reduce flash wear from frequent tiny appends.
			this.spoolWriteChunks.push(batchLines);
			this.spoolWriteBufferBytes += Buffer.byteLength(batchLines, 'utf8');

			if (this.spoolWriteBufferBytes >= this.SPOOL_WRITE_FLUSH_BYTES) {
				await this.flushSpoolWriteBuffer();
			} else if (!this.spoolWriteTimer) {
				this.spoolWriteTimer = setTimeout(() => {
					this.spoolWriteTimer = undefined;
					void this.flushSpoolWriteBuffer();
				}, this.SPOOL_WRITE_FLUSH_MS);
			}
		} catch (error) {
			console.error(`[CloudLog] Failed to write to spool: ${error}`);
		}
	}

	/**
	 * Flush queued spool writes to disk in one append operation.
	 */
	private async flushSpoolWriteBuffer(): Promise<void> {
		if (!this.spoolFilePath) return;

		if (this.spoolWriteFlushPromise) {
			await this.spoolWriteFlushPromise;
			return;
		}

		if (this.spoolWriteBufferBytes === 0) {
			if (this.spoolWriteTimer) {
				clearTimeout(this.spoolWriteTimer);
				this.spoolWriteTimer = undefined;
			}
			return;
		}

		if (this.spoolWriteTimer) {
			clearTimeout(this.spoolWriteTimer);
			this.spoolWriteTimer = undefined;
		}

		const payload = this.spoolWriteChunks.join('');
		const payloadBytes = this.spoolWriteBufferBytes;

		// Reset queue before I/O so producers can continue buffering.
		this.spoolWriteChunks = [];
		this.spoolWriteBufferBytes = 0;

		this.spoolWriteFlushPromise = (async () => {
			try {
				if (!this.spoolActiveSizeKnown) {
					try {
						const stats = await fsp.stat(this.spoolFilePath!);
						this.spoolActiveBytes = stats.size;
					} catch (error) {
						if ((error as any).code !== 'ENOENT') {
							throw error;
						}
						this.spoolActiveBytes = 0;
					}
					this.spoolActiveSizeKnown = true;
				}

				await fsp.appendFile(this.spoolFilePath!, payload, 'utf8');
				this.spoolActiveBytes += payloadBytes;

				if (this.spoolActiveBytes > this.maxSpoolSize) {
					await this.rotateSpool();
				}

				await this.enforceSpoolTotalSizeCap();
			} catch (error) {
				// Re-queue payload on failure to avoid data loss.
				this.spoolWriteChunks.unshift(payload);
				this.spoolWriteBufferBytes += payloadBytes;
				console.error(`[CloudLog] Failed to flush spool write buffer: ${error}`);
			}
		})();

		try {
			await this.spoolWriteFlushPromise;
		} finally {
			this.spoolWriteFlushPromise = undefined;
		}
	}
	
	/**
	 * Clear spool file after successful upload
	 * 
	 * ASYNC: Non-blocking unlink prevents event loop stalls
	 */
	private async clearSpool(): Promise<void> {
		if (!this.spoolFilePath) return;
		
		try {
			await this.flushSpoolWriteBuffer();
			const spoolFiles = await this.getSpoolFiles();
			for (const file of spoolFiles) {
				await fsp.unlink(file);
			}
			this.spoolActiveBytes = 0;
			this.spoolActiveSizeKnown = true;
			console.log('[CloudLog] Spool cleared after successful upload', {
				filesRemoved: spoolFiles.length
			});
		} catch (error) {
			// Ignore ENOENT (file already deleted)
			if ((error as any).code !== 'ENOENT') {
				console.error(`[CloudLog] Failed to clear spool: ${error}`);
			}
		}
	}
	
	/**
	 * Rotate spool file when it exceeds max size.
	 *
	 * DURABILITY: Never delete unsent data during rotation.
	 * We rename the active spool to a timestamped segment and continue writing to a new active file.
	 */
	private async rotateSpool(): Promise<void> {
		if (!this.spoolFilePath) return;
		
		try {
			const rotatedPath = `${this.spoolFilePath}.${Date.now()}`;
			await fsp.rename(this.spoolFilePath, rotatedPath);
			this.spoolActiveBytes = 0;
			this.spoolActiveSizeKnown = true;
			
			process.stderr.write(`[CloudLog] Spool rotated to preserve unsent data: ${path.basename(rotatedPath)}\n`);
		} catch (error) {
			// Ignore ENOENT (already deleted)
			if ((error as any).code !== 'ENOENT') {
				console.error(`[CloudLog] Failed to rotate spool: ${error}`);
			}
		}
	}
	
	/**
	 * Replay spooled logs from previous session on startup
	 * Loads batches back into pendingBatches for retry
	 * 
	 * ASYNC: Non-blocking read prevents startup delays on slow flash
	 */
	private async replaySpooledLogs(): Promise<void> {
		if (!this.spoolFilePath) return;
		
		try {
			await this.flushSpoolWriteBuffer();
			// Load ACK cursor (skip already-sent batches)
			const ackCursor = await this.loadAckCursor();
			const spoolFiles = await this.getSpoolFiles();
			
			if (spoolFiles.length === 0) {
				return;
			}
			
			console.log(`[CloudLog] Replaying spooled batches`, {
				spoolFiles: spoolFiles.map(file => path.basename(file)),
				lastAckBatchId: ackCursor.lastAckBatchId || 'none'
			});
			
			let replayedCount = 0;
			let skippedCount = 0;
			
			for (const spoolFile of spoolFiles) {
				// Parse batches and restore to pendingBatches (skip ACKed)
				for await (const line of this.streamSpoolLines(spoolFile)) {
					try {
						const batch: LogBatch = JSON.parse(line);
						
						// Skip already-ACKed batches (idempotency)
						if (this.isBatchAcked(batch.batchId, ackCursor)) {
							skippedCount++;
							continue;
						}
						
						// Restore batch to pending (will retry on next flush)
						this.pendingBatches.set(batch.batchId, batch);
						replayedCount++;
					} catch (parseError) {
						// Skip corrupted batch entries
						process.stderr.write(`[CloudLog] Skipping corrupted spool entry from ${path.basename(spoolFile)}: ${parseError}\n`);
					}
				}
			}
			
			console.log(`[CloudLog] Replayed ${replayedCount} batches, skipped ${skippedCount} ACKed batches`);
			
			// Trigger flush to retry pending batches
			if (replayedCount > 0) {
				setTimeout(() => this.flush(), 2000); // Delay to allow connection to establish
			}
		} catch (error) {
			console.error(`[CloudLog] Failed to replay spooled logs: ${error}`);
		}
	}

	/**
	 * Stream spool file as non-empty JSONL lines.
	 * Prevents loading large spool segments fully into memory.
	 */
	private async *streamSpoolLines(spoolFile: string): AsyncGenerator<string> {
		const stream = fs.createReadStream(spoolFile, { encoding: 'utf8' });
		const rl = readline.createInterface({
			input: stream,
			crlfDelay: Infinity
		});

		try {
			for await (const line of rl) {
				const trimmed = line.trim();
				if (trimmed.length === 0) {
					continue;
				}
				yield trimmed;
			}
		} finally {
			rl.close();
			stream.destroy();
		}
	}

	/**
	 * Enforce total spool disk cap across active + rotated segment files.
	 * Drops oldest data first to protect edge devices from disk exhaustion.
	 */
	private async enforceSpoolTotalSizeCap(): Promise<void> {
		if (!this.spoolFilePath) return;

		const spoolFiles = await this.getSpoolFiles();
		if (spoolFiles.length === 0) return;

		const fileInfos: Array<{ file: string; size: number; isActive: boolean }> = [];
		let totalBytes = 0;

		for (const file of spoolFiles) {
			try {
				const stats = await fsp.stat(file);
				const size = stats.size;
				fileInfos.push({ file, size, isActive: file === this.spoolFilePath });
				totalBytes += size;
			} catch {
				// Ignore race with concurrent delete/rotate.
			}
		}

		if (totalBytes <= this.maxTotalSpoolSize) {
			return;
		}

		let bytesToDrop = totalBytes - this.maxTotalSpoolSize;
		let droppedBytes = 0;

		// Drop oldest rotated segments first.
		for (const info of fileInfos) {
			if (bytesToDrop <= 0) break;
			if (info.isActive) continue;

			try {
				await fsp.unlink(info.file);
				bytesToDrop -= info.size;
				droppedBytes += info.size;
			} catch {
				// Ignore race with concurrent prune/clear.
			}
		}

		// If still above cap, trim oldest lines from active spool.
		if (bytesToDrop > 0) {
			try {
				const activeContent = await fsp.readFile(this.spoolFilePath, 'utf8');
				const lines = activeContent.split('\n').filter(line => line.trim());

				if (lines.length > 0) {
					let removeUntil = 0;
					let removedBytes = 0;

					while (removeUntil < lines.length && removedBytes < bytesToDrop) {
						removedBytes += Buffer.byteLength(lines[removeUntil] + '\n', 'utf8');
						removeUntil++;
					}

					const remaining = lines.slice(removeUntil);
					const tmpPath = this.spoolFilePath + '.tmp';
					const out = remaining.length > 0 ? remaining.join('\n') + '\n' : '';
					await fsp.writeFile(tmpPath, out, 'utf8');
					await fsp.rename(tmpPath, this.spoolFilePath);

					droppedBytes += removedBytes;
					this.spoolActiveBytes = Buffer.byteLength(out, 'utf8');
					this.spoolActiveSizeKnown = true;
				}
			} catch (error) {
				console.error(`[CloudLog] Failed trimming active spool for cap enforcement: ${error}`);
			}
		}

		if (droppedBytes > 0) {
			process.stderr.write(`[CloudLog] Total spool cap enforced: dropped ~${Math.round(droppedBytes / 1024)}KB oldest data\n`);
		}
	}
	
	/**
	 * Generate unique batch ID (deviceUuid-timestamp-counter)
	 * Format: {deviceUuid}-{timestamp}-{counter}
	 */
	private generateBatchId(): string {
		const timestamp = Date.now();
		const counter = this.nextBatchId++;
		return `${this.config.deviceUuid}-${timestamp}-${counter}`;
	}
	
	/**
	 * Update ACK cursor after successful batch send
	 * Tracks which batches have been confirmed by server
	 * 
	 * ASYNC: Non-blocking writes prevent event loop stalls
	 */
	private async updateAckCursor(batchId: string): Promise<void> {
		if (!this.spoolCursorPath) return;
		
		try {
			// Load existing cursor (async)
			let cursor: AckCursor = { lastAckTime: 0 };
			try {
				const content = await fsp.readFile(this.spoolCursorPath, 'utf8');
				cursor = JSON.parse(content);
			} catch {
				// File doesn't exist yet, use defaults
			}
			
			// Track only highest ACKed batch ID (monotonic)
			if (!cursor.lastAckBatchId || this.compareBatchIds(batchId, cursor.lastAckBatchId) > 0) {
				cursor.lastAckBatchId = batchId;
			}
			cursor.lastAckTime = Date.now();
			
			// Write atomically (tmp file + rename, async)
			const tmpPath = this.spoolCursorPath + '.tmp';
			await fsp.writeFile(tmpPath, JSON.stringify(cursor), 'utf8');
			await fsp.rename(tmpPath, this.spoolCursorPath);
		} catch (error) {
			console.error(`[CloudLog] Failed to update ACK cursor: ${error}`);
		}
	}
	
	/**
	 * Load ACK cursor from disk
	 * Returns last ACK cursor (highest batch ID that has been successfully sent)
	 * 
	 * ASYNC: Non-blocking read prevents startup delays
	 */
	private async loadAckCursor(): Promise<AckCursor> {
		if (!this.spoolCursorPath) return { lastAckTime: 0 };
		
		try {
			const content = await fsp.readFile(this.spoolCursorPath, 'utf8');
			const cursor: AckCursor = JSON.parse(content);
			return {
				lastAckBatchId: cursor.lastAckBatchId,
				lastAckTime: cursor.lastAckTime || 0
			};
		} catch (error) {
			// File doesn't exist or parse error
			if ((error as any).code !== 'ENOENT') {
				console.error(`[CloudLog] Failed to load ACK cursor: ${error}`);
			}
			return { lastAckTime: 0 };
		}
	}

	/**
	 * Compare monotonic batch IDs.
	 * Format: {deviceUuid}-{timestamp}-{counter}
	 */
	private compareBatchIds(a: string, b: string): number {
		const parse = (id: string): { timestamp: number; counter: number } | null => {
			const match = id.match(/-(\d+)-(\d+)$/);
			if (!match) return null;
			return {
				timestamp: Number(match[1]),
				counter: Number(match[2])
			};
		};

		const pa = parse(a);
		const pb = parse(b);

		if (!pa || !pb) {
			return a.localeCompare(b);
		}

		if (pa.timestamp !== pb.timestamp) {
			return pa.timestamp - pb.timestamp;
		}

		return pa.counter - pb.counter;
	}

	/**
	 * Determine if a batch is already ACKed based on monotonic cursor.
	 */
	private isBatchAcked(batchId: string, cursor: AckCursor): boolean {
		if (!cursor.lastAckBatchId) return false;
		return this.compareBatchIds(batchId, cursor.lastAckBatchId) <= 0;
	}
	
	/**
	 * Prune spool file by removing ACKed batches
	 * Atomic operation: read → filter → write to temp → rename
	 * 
	 * ASYNC: Non-blocking I/O prevents event loop stalls during pruning
	 */
	private async pruneSpoolByAcks(): Promise<void> {
		if (!this.spoolFilePath || !this.spoolCursorPath) return;
		
		try {
			await this.flushSpoolWriteBuffer();
			// Load ACK cursor
			const ackCursor = await this.loadAckCursor();
			
			if (!ackCursor.lastAckBatchId) {
				return; // No ACKs to prune
			}

			const spoolFiles = await this.getSpoolFiles();
			if (spoolFiles.length === 0) {
				return;
			}

			let totalPrunedCount = 0;
			let totalRemainingCount = 0;

			for (const spoolFile of spoolFiles) {
				const content = await fsp.readFile(spoolFile, 'utf8');
				const lines = content.split('\n').filter(line => line.trim());
				
				// Filter out ACKed batches
				const remainingLines: string[] = [];
				let prunedCount = 0;
				
				for (const line of lines) {
					try {
						const batch: LogBatch = JSON.parse(line);
						if (this.isBatchAcked(batch.batchId, ackCursor)) {
							prunedCount++;
						} else {
							remainingLines.push(line);
						}
					} catch (parseError) {
						// Keep corrupted lines (will be handled later)
						remainingLines.push(line);
					}
				}

				totalPrunedCount += prunedCount;
				totalRemainingCount += remainingLines.length;

				if (prunedCount === 0) {
					continue;
				}

				if (remainingLines.length === 0) {
					// Safe to remove only when all lines in this segment were ACKed
					await fsp.unlink(spoolFile);
					continue;
				}

				// Write atomically (tmp file + rename, async)
				const tmpPath = spoolFile + '.tmp';
				await fsp.writeFile(tmpPath, remainingLines.join('\n') + '\n', 'utf8');
				await fsp.rename(tmpPath, spoolFile);
			}

			if (totalPrunedCount > 0) {
				console.log(`[CloudLog] Pruned ${totalPrunedCount} ACKed batches from spool segments (${totalRemainingCount} remaining)`);
			}

			// Active spool size may have changed after prune/rewrite.
			this.spoolActiveSizeKnown = false;
		} catch (error) {
			console.error(`[CloudLog] Failed to prune spool: ${error}`);
		}
	}

	/**
	 * Get all spool segment files (active + rotated).
	 * Sorted oldest -> newest for stable replay behavior.
	 */
	private async getSpoolFiles(): Promise<string[]> {
		if (!this.spoolPath || !this.spoolFilePath) {
			return [];
		}

		const baseName = path.basename(this.spoolFilePath);

		try {
			const entries = await fsp.readdir(this.spoolPath);
			const files = entries.filter(name => name === baseName || name.startsWith(baseName + '.'));

			const rotated = files
				.filter(name => name !== baseName)
				.sort((a, b) => {
					const aTs = Number(a.slice((baseName + '.').length)) || 0;
					const bTs = Number(b.slice((baseName + '.').length)) || 0;
					return aTs - bTs;
				})
				.map(name => path.join(this.spoolPath!, name));

			const active = files.includes(baseName) ? [path.join(this.spoolPath!, baseName)] : [];

			return [...rotated, ...active];
		} catch {
			return [];
		}
	}
}
