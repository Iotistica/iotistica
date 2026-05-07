/**
 * Cloud Log Backend
 * ==================
 *
 * Streams container logs to cloud API in real-time.
 *
 * Concerns handled here:
 * - In-memory ring buffer + adaptive batch sizing
 * - Circuit breaker + exponential backoff reconnect
 * - Dropped-log summary tracking
 * - Orchestration of LogSampler and LogSpool
 *
 * See also:
 * - types.ts             — shared data interfaces (LogMessage, LogBatch, etc.)
 * - log-sampler.ts       — sampling / classification logic
 * - log-spool.ts         — disk durability layer
 */

import type { LogBackend, LogMessage, LogFilter } from './types';
import type { AgentLogger } from '../logging/agent-logger';
import { buildApiEndpoint } from '../utils/api-utils';
import { RetryPolicy } from '../utils/retry-policy';
import { isRetryableNetworkError, getNetworkErrorType } from '../utils/network';
import { FetchHttpClient, type HttpClient } from '../lib/http-client';
import type { CloudLogBackendConfig, LogBatch, DroppedLogSummary } from './types';
import { LogSampler } from './log-sampler';
import { LogSpool } from './log-spool';

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
	private sampler!: LogSampler;
	private spool?: LogSpool;
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
	
	constructor(config: CloudLogBackendConfig, _logger?: AgentLogger) {
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
		// Create LogSpool if a spool path is configured (directory created in initialize())
		if (this.config.spoolPath) {
			this.spool = new LogSpool({
				spoolPath: this.config.spoolPath,
				maxSpoolSizeMb: this.config.maxSpoolSizeMb,
				maxTotalSpoolSizeMb: this.config.maxTotalSpoolSizeMb,
			});
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
	
		// Initialize sampler (stateless — circuitBreakerOpen is passed per-call in log())
		this.sampler = new LogSampler(config.deviceUuid, config.samplingRates);

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
				
				onFailure: (error, _attempts) => {
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
		if (this.spool) {
			try {
				await this.spool.initialize();
			} catch (error) {
				console.error(`[CloudLog] Spool initialization failed, disabling spool: ${error}`);
				this.spool = undefined;
			}
		}

		if (this.spool) {
			const replayed = await this.spool.replay();
			for (const [batchId, batch] of replayed) {
				this.pendingBatches.set(batchId, batch);
			}
			if (replayed.size > 0) {
				setTimeout(() => void this.flush(), 2000);
			}
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
		if (!this.sampler.shouldSample(logMessage, this.circuitBreakerOpen)) {
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
			if (!this.sampler.isCriticalLog(logMessage)) {
				return;
			}
		}
		
		// Hot path: use lightweight size estimate (avoid JSON.stringify per log).
		const logSize = this.sampler.estimateLogSize(logMessage);
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
	
	async getLogs(_filter?: LogFilter): Promise<LogMessage[]> {
		// CloudLogBackend doesn't store logs locally (they're streamed to cloud)
		// Return empty array
		return [];
	}
	
	async getLogCount(): Promise<number> {
		return 0;
	}
	
	async cleanup(_olderThanMs: number): Promise<number> {
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
		console.log('[CloudSync] Stopping Cloud Log Backend...');

		// Flush remaining logs then gracefully shut down the spool
		await this.flush();
		await this.spool?.stop();

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
							if (this.sampler.isCriticalLog(log)) {
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
							this.bufferBytes += this.sampler.estimateLogSize(log);
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
			const _totalLogsToFlush = this.buffer.length; // Store before clearing
		
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
				if (this.spool) {
					await this.spool.write(logBatches);
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
					if (this.spool) {
						await this.spool.updateAckCursor(logBatch.batchId);
					}
				
					// Increase batch size gradually (additive increase)
					this.consecutiveSuccesses++;
				
					// Grow by 10% every 3 consecutive successes
					if (this.consecutiveSuccesses >= 3) {
						const _oldSize = this.adaptiveBatchSize;
						const _oldBytes = this.adaptiveMaxBytes;
					
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
			if (this.spool && this.pendingBatches.size === 0) {
			// All batches ACKed - safe to clear spool
				await this.spool.clear();
			} else if (this.spool) {
			// Partial success - prune ACKed batches from spool
				await this.spool.pruneByAcks();
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
			const level = log.level || this.sampler.detectLogLevel(log);
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
	
}

