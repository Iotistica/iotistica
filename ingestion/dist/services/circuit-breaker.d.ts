export declare enum CircuitState {
    CLOSED = "CLOSED",
    OPEN = "OPEN",
    HALF_OPEN = "HALF_OPEN"
}
export declare class RedisCircuitBreaker {
    private state;
    private failureCount;
    private successCount;
    private lastFailureTime;
    private readonly failureThreshold;
    private readonly successThreshold;
    private readonly timeoutMs;
    recordSuccess(): void;
    recordFailure(): void;
    shouldAllowRequest(): boolean;
    getState(): CircuitState;
    reset(): void;
}
export declare const circuitBreaker: RedisCircuitBreaker;
//# sourceMappingURL=circuit-breaker.d.ts.map