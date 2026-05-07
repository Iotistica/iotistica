/**
 * Generic retry policy for any async operation
 * Optimized for edge devices - zero external dependencies
 */

export interface RetryPolicyConfig {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	backoffMultiplier: number;
	onRetry?: (attempt: number, error: unknown, remainingAttempts: number) => void;
	onFailure?: (error: unknown, totalAttempts: number) => void;
	onSuccess?: () => void;
}

export interface RetryableError {
	isRetryable: (error: unknown) => boolean;
}

/**
 * Simple retry policy for network operations
 * No external dependencies, minimal memory footprint
 */
export class RetryPolicy {
	private consecutiveFailures: number = 0;
	
	constructor(
		private config: RetryPolicyConfig,
		private errorClassifier: RetryableError
	) {}
	
	/**
	* Execute function with retry logic
	* @returns Result of successful execution
	* @throws Last error if all retries exhausted
	*/
	async execute<T>(fn: () => Promise<T>): Promise<T> {
		let lastError: unknown;
		
		for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
			try {
				const result = await fn();
				
				// Success - reset counter and call callback
				this.consecutiveFailures = 0;
				this.config.onSuccess?.();
				
				return result;
			} catch (error) {
				lastError = error;
				this.consecutiveFailures++;
				
				// Check if error is retryable
				if (!this.errorClassifier.isRetryable(error)) {
					// Non-retryable error - fail fast
					this.config.onFailure?.(error, attempt);
					throw error;
				}
				
				// Last attempt - don't wait, just throw
				if (attempt >= this.config.maxAttempts) {
					this.config.onFailure?.(error, attempt);
					break;
				}
				
				// Calculate backoff and notify
				const delay = this.calculateBackoff(attempt);
				const remaining = this.config.maxAttempts - attempt;
				
				this.config.onRetry?.(attempt, error, remaining);
				
				// Wait before next attempt
				await this.sleep(delay);
			}
		}
		
		// All attempts exhausted
		throw lastError;
	}
	
	/**
	* Execute with simplified error handling
	* Returns undefined if all retries fail instead of throwing
	*/
	async executeSafe<T>(fn: () => Promise<T>): Promise<T | undefined> {
		try {
			return await this.execute(fn);
		} catch {
			return undefined;
		}
	}
	
	/**
	* Get current consecutive failure count
	*/
	getConsecutiveFailures(): number {
		return this.consecutiveFailures;
	}
	
	/**
	* Get remaining attempts before giving up
	*/
	getRemainingAttempts(): number {
		return Math.max(0, this.config.maxAttempts - this.consecutiveFailures);
	}
	
	/**
	* Check if we've hit max failures
	*/
	hasExhaustedRetries(): boolean {
		return this.consecutiveFailures >= this.config.maxAttempts;
	}
	
	/**
	* Manually reset failure counter
	*/
	reset(): void {
		this.consecutiveFailures = 0;
	}
	
	/**
	* Calculate exponential backoff delay
	*/
	private calculateBackoff(attempt: number): number {
		const delay = this.config.baseDelayMs * 
			Math.pow(this.config.backoffMultiplier, attempt - 1);
		return Math.min(delay, this.config.maxDelayMs);
	}
	
	/**
	* Sleep helper
	*/
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
	
	/**
	* Calculate exponential backoff delay with optional jitter
	* Useful for scheduling retry intervals in polling loops
	* 
	* @param attempt Current attempt number (1-based)
	* @param baseDelayMs Initial delay in milliseconds
	* @param multiplier Exponential backoff multiplier (typically 2)
	* @param maxDelayMs Maximum delay cap
	* @param jitterPercent Optional jitter as percentage (0.3 = ±30%), prevents thundering herd
	* @returns Calculated delay in milliseconds
	*/
	static calculateBackoffWithJitter(
		attempt: number,
		baseDelayMs: number,
		multiplier: number,
		maxDelayMs: number,
		jitterPercent: number = 0
	): number {
		// Calculate base exponential backoff
		const exponentialDelay = baseDelayMs * Math.pow(multiplier, attempt - 1);
		const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
		
		// Apply jitter if requested
		if (jitterPercent > 0) {
			const jitter = (Math.random() * 2 - 1) * jitterPercent; // Random between -jitterPercent and +jitterPercent
			return Math.floor(cappedDelay * (1 + jitter));
		}
		
		return cappedDelay;
	}
}

/**
 * Circuit breaker for poll/report loops
 * Stops trying after max consecutive failures and enters cooldown period
 * 
 * Example usage:
 * ```typescript
 * const circuit = new CircuitBreaker(10, 5 * 60 * 1000); // 10 failures, 5min cooldown
 * 
 * if (circuit.isOpen()) {
 *   // Skip operation, circuit is cooling down
 *   return;
 * }
 * 
 * try {
 *   await operation();
 *   circuit.recordSuccess(); // Reset counter
 * } catch (error) {
 *   const opened = circuit.recordFailure(); // Returns true if circuit just opened
 *   if (opened) {
 *     logger.error('Circuit breaker tripped');
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
	private failureCount: number = 0;
	private openUntil: number = 0;
	
	constructor(
		private maxFailures: number = 10,
		private cooldownMs: number = 5 * 60 * 1000 // 5 minutes default
	) {}
	
	/**
	* Check if circuit breaker is open (in cooldown)
	* @returns true if circuit is open and operation should be skipped
	*/
	isOpen(): boolean {
		if (this.openUntil > 0 && Date.now() < this.openUntil) {
			return true; // Still in cooldown
		}
		if (this.openUntil > 0 && Date.now() >= this.openUntil) {
			this.reset(); // Cooldown expired, try again
		}
		return false;
	}
	
	/**
	* Record successful operation (resets failure counter)
	*/
	recordSuccess(): void {
		this.failureCount = 0;
		this.openUntil = 0;
	}
	
	/**
	* Record failed operation
	* @returns true if circuit just opened (max failures reached)
	*/
	recordFailure(): boolean {
		this.failureCount++;
		if (this.failureCount >= this.maxFailures) {
			this.openUntil = Date.now() + this.cooldownMs;
			return true; // Circuit opened
		}
		return false; // Still closed
	}
	
	/**
	* Get current consecutive failure count
	*/
	getFailureCount(): number {
		return this.failureCount;
	}
	
	/**
	* Get remaining cooldown time in milliseconds
	* @returns 0 if circuit is closed
	*/
	getCooldownRemaining(): number {
		if (this.openUntil === 0) return 0;
		return Math.max(0, this.openUntil - Date.now());
	}
	
	/**
	* Manually reset circuit breaker
	*/
	reset(): void {
		this.failureCount = 0;
		this.openUntil = 0;
	}
}

/**
 * Prevents concurrent executions of async operations
 * Useful for poll/report loops to prevent overlapping requests
 * 
 * Example usage:
 * ```typescript
 * const lock = new AsyncLock();
 * 
 * // Pattern 1: Manual acquire/release
 * if (!await lock.acquire()) {
 *   // Already locked, skip
 *   return;
 * }
 * try {
 *   await operation();
 * } finally {
 *   lock.release();
 * }
 * 
 * // Pattern 2: Auto-managed
 * const result = await lock.tryExecute(async () => {
 *   return await operation();
 * });
 * if (result === undefined) {
 *   // Already locked, operation skipped
 * }
 * ```
 */
export class AsyncLock {
	private locked: boolean = false;
	
	/**
	* Try to acquire lock
	* @returns true if lock acquired, false if already locked
	*/
	async acquire(): Promise<boolean> {
		if (!this.locked) {
			this.locked = true;
			return true; // Acquired immediately
		}
		return false; // Already locked
	}
	
	/**
	* Release lock
	*/
	release(): void {
		this.locked = false;
	}
	
	/**
	* Check if currently locked
	*/
	isLocked(): boolean {
		return this.locked;
	}
	
	/**
	* Execute function with lock protection
	* @returns Result of function, or undefined if lock could not be acquired
	*/
	async tryExecute<T>(fn: () => Promise<T>): Promise<T | undefined> {
		const acquired = await this.acquire();
		if (!acquired) return undefined;
		
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
}

/**
 * Check if HTTP error is an auth error (401/403)
 * Useful for detecting when credentials need refresh
 */
export function isAuthError(error: unknown): boolean {
	if (error && typeof error === 'object' && 'status' in error) {
		const status = (error as any).status;
		return status === 401 || status === 403;
	}
	return false;
}

/**
 * Check if HTTP error is retryable (network errors, timeouts, 5xx)
 * Auth errors (401/403) are NOT retryable - they need credential refresh
 */
export function isRetryableHttpError(error: unknown): boolean {
	if (!error) return false;
	
	// Auth errors - should trigger credential refresh, not retry
	if (isAuthError(error)) return false;
	
	// Network errors (ECONNREFUSED, ETIMEDOUT, etc.)
	if (error && typeof error === 'object') {
		const err = error as any;
		if (err.code === 'ECONNREFUSED' || 
		err.code === 'ETIMEDOUT' || 
		err.code === 'ENOTFOUND' ||
		err.code === 'ECONNRESET' ||
		err.name === 'AbortError') {
			return true;
		}
	}
	
	// 5xx server errors
	if (error && typeof error === 'object' && 'status' in error) {
		const status = (error as any).status;
		return status >= 500 && status < 600;
	}
	
	return false;
}

