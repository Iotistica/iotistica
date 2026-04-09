export interface BackoffOptions {
    baseMs?: number;
    maxMs?: number;
    multiplier?: number;
    jitterFactor?: number;
}
export declare function backoffDelayMs(attempt: number, opts?: BackoffOptions): number;
export declare function sleep(ms: number): Promise<void>;
//# sourceMappingURL=retry-utils.d.ts.map