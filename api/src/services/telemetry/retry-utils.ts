export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  multiplier?: number;
  jitterFactor?: number;
}

/**
 * Returns the delay in ms for the given attempt (0-indexed) using exponential
 * backoff with uniform jitter.
 *
 * Defaults: base=100ms, max=2000ms, 2× multiplier, ±25% jitter.
 * Sequence (no jitter): 100 → 200 → 400 → 800 → 1600 → 2000ms (clamped)
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 100;
  const max = opts.maxMs ?? 2000;
  const multiplier = opts.multiplier ?? 2;
  const jitter = opts.jitterFactor ?? 0.25;

  const raw = Math.min(base * Math.pow(multiplier, attempt), max);
  const range = raw * jitter;
  // Uniform jitter in [-range, +range]
  return Math.round(raw + (Math.random() * 2 - 1) * range);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
