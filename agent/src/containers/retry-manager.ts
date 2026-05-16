/**
 * RETRY MANAGER
 * ==============
 * 
 * Implements Kubernetes-style exponential backoff for failed operations
 * Similar to ImagePullBackOff behavior
 * 
 * EDGE DEVICE HARDENING:
 * - SQLite persistence: Retry state survives agent restarts (prevents retry storms)
 * - Jitter: Randomized backoff to prevent thundering herd (Kubernetes-style)
 */

import { RetryStateModel, type RetryStateRecord } from '../db/models';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

export interface RetryState {
	count: number;
	nextRetry: Date;
	lastError: string;
	terminal: boolean; // True when MAX_RETRIES exceeded (resource permanently failed)
	retryable: boolean; // False for non-retryable errors (auth, config errors)
}

export interface RetryPolicy {
	maxRetries: number;
	backoffIntervals: number[]; // Milliseconds for each retry attempt
}

// Default policy: Kubernetes-style exponential backoff
const DEFAULT_POLICY: RetryPolicy = {
	maxRetries: 10,
	backoffIntervals: [
		10 * 1000,    // 10s
		20 * 1000,    // 20s
		40 * 1000,    // 40s
		80 * 1000,    // 1m 20s
		160 * 1000,   // 2m 40s
		300 * 1000,   // 5m (max backoff)
	],
};

// Aggressive policy for local Docker operations (fast retries, fewer attempts)
export const DOCKER_POLICY: RetryPolicy = {
	maxRetries: 5,
	backoffIntervals: [
		2 * 1000,     // 2s
		5 * 1000,     // 5s
		10 * 1000,    // 10s
		20 * 1000,    // 20s
		30 * 1000,    // 30s
	],
};

/**
 * Classify if an error is retryable based on error message/code
 * Non-retryable errors: auth failures, config errors, invalid parameters
 * Retryable errors: network issues, timeouts, service unavailable
 */
export function isRetryableError(error: string): boolean {
	const errorLower = error.toLowerCase();
	
	// Non-retryable: Authentication/Authorization
	if (errorLower.includes('401') || errorLower.includes('unauthorized')) return false;
	if (errorLower.includes('403') || errorLower.includes('forbidden')) return false;
	if (errorLower.includes('invalid credentials')) return false;
	if (errorLower.includes('authentication failed')) return false;
	
	// Non-retryable: Configuration errors
	if (errorLower.includes('invalid subnet')) return false;
	if (errorLower.includes('invalid cidr')) return false;
	if (errorLower.includes('invalid parameter')) return false;
	if (errorLower.includes('validation error')) return false;
	if (errorLower.includes('bad request') && errorLower.includes('400')) return false;
	
	// Non-retryable: Resource already exists (idempotency issue)
	if (errorLower.includes('already exists')) return false;
	if (errorLower.includes('duplicate')) return false;
	
	// Retryable: Network errors
	if (errorLower.includes('enotfound')) return true;
	if (errorLower.includes('econnrefused')) return true;
	if (errorLower.includes('econnreset')) return true;
	if (errorLower.includes('etimedout')) return true;
	if (errorLower.includes('network')) return true;
	
	// Retryable: Service errors
	if (errorLower.includes('503') || errorLower.includes('service unavailable')) return true;
	if (errorLower.includes('502') || errorLower.includes('bad gateway')) return true;
	if (errorLower.includes('504') || errorLower.includes('gateway timeout')) return true;
	if (errorLower.includes('429') || errorLower.includes('too many requests')) return true;
	
	// Default: retry (conservative approach for unknown errors)
	return true;
}

export class RetryManager {
	private retryState = new Map<string, RetryState>();
	private initialized = false;
	private readonly policy: RetryPolicy;

	constructor(
		private logger?: AgentLogger,
		policy?: RetryPolicy
	) {
		this.policy = policy || DEFAULT_POLICY;
		// Load retry state from database on initialization
		this.loadStateFromDatabase().catch(err => {
			this.logger?.warnSync('Failed to load retry state from database', {
				component: LogComponents.containerManager,
				error: err.message,
			});
		});
	}
	
	/**
	* Load retry state from SQLite database
	* Ensures retry state survives agent restarts (prevents retry storms on reboot loops)
	*/
	private async loadStateFromDatabase(): Promise<void> {
		try {
			const rows = RetryStateModel.getAll();
			
			for (const row of rows) {
				this.retryState.set(row.key, {
					count: row.count,
					nextRetry: new Date(row.next_retry),
					lastError: row.last_error,
					terminal: row.terminal === 1,
					retryable: row.retryable !== 0, // Default to true if missing
				});
			}
			
			this.initialized = true;
			
			if (rows.length > 0) {
				this.logger?.infoSync('Loaded retry state from database', {
					component: LogComponents.containerManager,
					count: rows.length,
					message: 'Retry backoff preserved across agent restart',
				});
			}
		} catch (_err: any) {
			// Table might not exist yet - that's okay, it will be created on first write
			this.initialized = true;
		}
	}
	
	/**
	* Persist retry state to SQLite database
	* Ensures state survives agent restarts (critical for edge devices with reboot loops)
	*/
	private async persistToDatabase(key: string, state: RetryState): Promise<void> {
		try {
			const record: RetryStateRecord = {
				key,
				count: state.count,
				next_retry: state.nextRetry.toISOString(),
				last_error: state.lastError,
				terminal: state.terminal ? 1 : 0,
				retryable: state.retryable ? 1 : 0,
				updated_at: new Date().toISOString(),
			};

			RetryStateModel.upsert(record);
		} catch (err: any) {
			this.logger?.warnSync('Failed to persist retry state', {
				component: LogComponents.containerManager,
				key,
				error: err.message,
			});
		}
	}
	
	/**
	* Delete retry state from database
	*/
	private async deleteFromDatabase(key: string): Promise<void> {
		try {
			RetryStateModel.delete(key);
		} catch (err: any) {
			this.logger?.warnSync('Failed to delete retry state', {
				component: LogComponents.containerManager,
				key,
				error: err.message,
			});
		}
	}
	
	/**
	* Check if we should retry an operation
	*/
	public shouldRetry(key: string): boolean {
		const state = this.retryState.get(key);
		
		// First attempt - always allow
		if (!state) {
			return true;
		}
		
		// Terminal state - permanently failed, no more retries
		if (state.terminal) {
			return false;
		}
		
		// Max retries exceeded (should be terminal, but check anyway)
		if (state.count >= this.policy.maxRetries) {
			return false;
		}
		
		// Check if enough time has passed since last failure
		return new Date() >= state.nextRetry;
	}
	
	/**
	* Record a failure and calculate next retry time
	* Adds jitter to prevent thundering herd, persists to SQLite to survive restarts
	* 
	* @param key - Unique identifier for the operation
	* @param error - Error message/description
	* @param retryable - Whether error is retryable (defaults to auto-classification)
	*/
	public recordFailure(key: string, error: string, retryable?: boolean): void {
		// Auto-classify if not explicitly specified
		const isRetryable = retryable !== undefined ? retryable : isRetryableError(error);
		
		const state = this.retryState.get(key) || {
			count: 0,
			nextRetry: new Date(),
			lastError: '',
			terminal: false,
			retryable: true,
		};
		
		// Non-retryable error → immediate terminal state (don't waste retries)
		if (!isRetryable) {
			state.terminal = true;
			state.retryable = false;
			state.lastError = error;
			// Don't increment count for non-retryable errors
			
			this.retryState.set(key, state);
			
			this.logger?.errorSync('Non-retryable error - immediate terminal state', undefined, {
				component: LogComponents.containerManager,
				key,
				error,
				message: 'Error is non-retryable (auth, config, or validation error). Manual fix required.',
			});
			
			// Persist to database
			this.persistToDatabase(key, state).catch(() => {});
			return;
		}
		
		// Retryable error → normal backoff logic
		state.count++;
		state.lastError = error;
		state.retryable = true;
		
		// Check if this is the final retry (transition to terminal state)
		if (state.count >= this.policy.maxRetries) {
			state.terminal = true;
			
			this.logger?.errorSync('Retry limit exceeded - terminal state', undefined, {
				component: LogComponents.containerManager,
				key,
				attempts: state.count,
				maxRetries: this.policy.maxRetries,
				lastError: error,
				message: 'Resource permanently failed. Manual intervention required or clearState() to reset.',
			});
		} else {
			// Calculate backoff interval (capped at max)
			const backoffIndex = Math.min(state.count - 1, this.policy.backoffIntervals.length - 1);
			
			// Add jitter to prevent thundering herd (Kubernetes-style)
			// Critical for fleet-wide failures (power loss, network outage, API downtime)
			// 85%–115% jitter prevents synchronized retries across fleet
			const jitter = Math.random() * 0.3 + 0.85; // 85%–115%
			const backoffMs = Math.floor(this.policy.backoffIntervals[backoffIndex] * jitter);
			
			state.nextRetry = new Date(Date.now() + backoffMs);
			
			this.logger?.debugSync('Retry scheduled', {
				component: LogComponents.containerManager,
				key,
				attempt: state.count,
				maxRetries: this.policy.maxRetries,
				backoffMs,
				nextRetry: state.nextRetry.toISOString(),
			});
		}
		
		this.retryState.set(key, state);
		
		// Persist to database (survive agent restarts)
		this.persistToDatabase(key, state).catch(() => {
			// Non-fatal error, already logged in persistToDatabase
		});
	}
	
	/**
	* Record a success (clears retry state from memory and database)
	*/
	public recordSuccess(key: string): void {
		const state = this.retryState.get(key);
		if (state && state.count > 0) {
			this.logger?.infoSync('Retry succeeded', {
				component: LogComponents.containerManager,
				key,
				attempts: state.count,
			});
		}
		this.retryState.delete(key);
		
		// Remove from database
		this.deleteFromDatabase(key).catch(() => {
			// Non-fatal error, already logged in deleteFromDatabase
		});
	}
	
	/**
	* Get retry state for a key
	*/
	public getState(key: string): RetryState | undefined {
		return this.retryState.get(key);
	}
	
	/**
	* Check if max retries exceeded
	*/
	public isMaxRetriesExceeded(key: string): boolean {
		const state = this.retryState.get(key);
		return state ? state.count >= this.policy.maxRetries : false;
	}
	
	/**
	* Check if a resource is in terminal state (permanently failed)
	*/
	public isTerminal(key: string): boolean {
		const state = this.retryState.get(key);
		return state ? state.terminal : false;
	}
	
	/**
	* Get all resources in terminal state (for cleanup/observability)
	* Kubernetes-style: allows external monitoring to detect permanently failed resources
	*/
	public getTerminalStates(): Map<string, RetryState> {
		const terminal = new Map<string, RetryState>();
		for (const [key, state] of this.retryState) {
			if (state.terminal) {
				terminal.set(key, state);
			}
		}
		return terminal;
	}
	
	/**
	* Get all retry states (for reporting)
	*/
	public getAllStates(): Map<string, RetryState> {
		return new Map(this.retryState);
	}
	
	/**
	* Clear retry state for a specific key (memory and database)
	*/
	public clearState(key: string): void {
		this.retryState.delete(key);
		this.deleteFromDatabase(key).catch(() => {
			// Non-fatal error, already logged
		});
	}
	
	/**
	* Clear all retry states (memory and database)
	*/
	public async clearAllStates(): Promise<void> {
		this.retryState.clear();
		try {
			RetryStateModel.clearAll();
		} catch (err: any) {
			this.logger?.warnSync('Failed to clear retry state from database', {
				component: LogComponents.containerManager,
				error: err.message,
			});
		}
	}
}
