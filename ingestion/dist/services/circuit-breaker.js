"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.circuitBreaker = exports.RedisCircuitBreaker = exports.CircuitState = void 0;
const logger_1 = require("../utils/logger");
var CircuitState;
(function (CircuitState) {
    CircuitState["CLOSED"] = "CLOSED";
    CircuitState["OPEN"] = "OPEN";
    CircuitState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitState || (exports.CircuitState = CircuitState = {}));
class RedisCircuitBreaker {
    state = CircuitState.CLOSED;
    failureCount = 0;
    successCount = 0;
    lastFailureTime = 0;
    failureThreshold = 5;
    successThreshold = 3;
    timeoutMs = 30000;
    recordSuccess() {
        this.failureCount = 0;
        if (this.state === CircuitState.HALF_OPEN) {
            this.successCount++;
            if (this.successCount >= this.successThreshold) {
                logger_1.logger.info('Redis circuit breaker CLOSED - connection recovered', {
                    previousState: this.state,
                    successCount: this.successCount,
                });
                this.state = CircuitState.CLOSED;
                this.successCount = 0;
            }
        }
    }
    recordFailure() {
        this.successCount = 0;
        this.failureCount++;
        this.lastFailureTime = Date.now();
        if (this.state === CircuitState.CLOSED && this.failureCount >= this.failureThreshold) {
            logger_1.logger.error('Redis circuit breaker OPEN - switching to disk spool fallback', {
                failureCount: this.failureCount,
                threshold: this.failureThreshold,
            });
            this.state = CircuitState.OPEN;
        }
        else if (this.state === CircuitState.HALF_OPEN) {
            logger_1.logger.warn('Redis circuit breaker OPEN again - recovery failed', { previousState: this.state });
            this.state = CircuitState.OPEN;
        }
    }
    shouldAllowRequest() {
        if (this.state === CircuitState.CLOSED)
            return true;
        if (this.state === CircuitState.OPEN) {
            if (Date.now() - this.lastFailureTime >= this.timeoutMs) {
                logger_1.logger.info('Redis circuit breaker HALF_OPEN - probing recovery');
                this.state = CircuitState.HALF_OPEN;
                this.failureCount = 0;
                return true;
            }
            return false;
        }
        return true;
    }
    getState() {
        return this.state;
    }
    reset() {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
    }
}
exports.RedisCircuitBreaker = RedisCircuitBreaker;
exports.circuitBreaker = new RedisCircuitBreaker();
//# sourceMappingURL=circuit-breaker.js.map