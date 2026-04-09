"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.backoffDelayMs = backoffDelayMs;
exports.sleep = sleep;
function backoffDelayMs(attempt, opts = {}) {
    const base = opts.baseMs ?? 100;
    const max = opts.maxMs ?? 2000;
    const multiplier = opts.multiplier ?? 2;
    const jitter = opts.jitterFactor ?? 0.25;
    const raw = Math.min(base * Math.pow(multiplier, attempt), max);
    const range = raw * jitter;
    return Math.round(raw + (Math.random() * 2 - 1) * range);
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=retry-utils.js.map