import { logger } from '../utils/logger';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class RedisCircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold = 5;
  private readonly successThreshold = 3;
  private readonly timeoutMs = 30000;

  recordSuccess(): void {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        logger.info('Redis circuit breaker CLOSED - connection recovered', {
          previousState: this.state,
          successCount: this.successCount,
        });
        this.state = CircuitState.CLOSED;
        this.successCount = 0;
      }
    }
  }

  recordFailure(): void {
    this.successCount = 0;
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.CLOSED && this.failureCount >= this.failureThreshold) {
      logger.error('Redis circuit breaker OPEN - switching to disk spool fallback', {
        failureCount: this.failureCount,
        threshold: this.failureThreshold,
      });
      this.state = CircuitState.OPEN;
    } else if (this.state === CircuitState.HALF_OPEN) {
      logger.warn('Redis circuit breaker OPEN again - recovery failed', { previousState: this.state });
      this.state = CircuitState.OPEN;
    }
  }

  shouldAllowRequest(): boolean {
    if (this.state === CircuitState.CLOSED) return true;
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.timeoutMs) {
        logger.info('Redis circuit breaker HALF_OPEN - probing recovery');
        this.state = CircuitState.HALF_OPEN;
        this.failureCount = 0;
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
  }
}

export const circuitBreaker = new RedisCircuitBreaker();
