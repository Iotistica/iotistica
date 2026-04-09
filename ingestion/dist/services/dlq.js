"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FAILURE_TRACKING_KEY = void 0;
exports.incrementFailureCount = incrementFailureCount;
exports.getFailureCount = getFailureCount;
exports.moveToDLQ = moveToDLQ;
exports.startFailureTrackingPruner = startFailureTrackingPruner;
const logger_1 = require("../utils/logger");
const redis_scripts_1 = require("./redis-scripts");
exports.FAILURE_TRACKING_KEY = 'device:failed:attempts';
async function incrementFailureCount(redis, messageId) {
    return (0, redis_scripts_1.hIncrByAndExpire)(redis, exports.FAILURE_TRACKING_KEY, messageId, 24 * 60 * 60);
}
async function getFailureCount(redis, messageId) {
    const attempts = await redis.hget(exports.FAILURE_TRACKING_KEY, messageId);
    return attempts ? parseInt(attempts, 10) : 0;
}
async function moveToDLQ(redis, streamKey, consumerGroup, dlqStreamKey, maxDlqLength, entry, error, attempts) {
    try {
        await (0, redis_scripts_1.moveToDlqAtomic)(redis, streamKey, dlqStreamKey, exports.FAILURE_TRACKING_KEY, consumerGroup, entry.id, JSON.stringify(entry.data), maxDlqLength, error, attempts, new Date().toISOString());
    }
    catch (err) {
        logger_1.logger.error('Failed to move message to DLQ — message stays in PEL for retry', {
            messageId: entry.id,
            error: err instanceof Error ? err.message : String(err),
        });
        return;
    }
    logger_1.logger.warn('Message moved to DLQ after max retries', {
        messageId: entry.id,
        attempts,
        error,
        deviceUuid: entry.data.deviceUuid,
        deviceName: entry.data.deviceName,
    });
}
function startFailureTrackingPruner(redis) {
    return setInterval(async () => {
        try {
            const allEntries = await redis.hgetall(exports.FAILURE_TRACKING_KEY);
            if (!allEntries || Object.keys(allEntries).length === 0)
                return;
            const now = Date.now();
            const maxAgeMs = 24 * 60 * 60 * 1000;
            let prunedCount = 0;
            for (const messageId of Object.keys(allEntries)) {
                try {
                    const timestamp = parseInt(messageId.split('-')[0], 10);
                    if (now - timestamp > maxAgeMs) {
                        await redis.hdel(exports.FAILURE_TRACKING_KEY, messageId);
                        prunedCount++;
                    }
                }
                catch {
                    await redis.hdel(exports.FAILURE_TRACKING_KEY, messageId);
                    prunedCount++;
                }
            }
            if (prunedCount > 0) {
                logger_1.logger.debug('Pruned old failure tracking entries', {
                    pruned: prunedCount,
                    remaining: Object.keys(allEntries).length - prunedCount,
                });
            }
        }
        catch (err) {
            logger_1.logger.error('Failed to prune failure tracking hash', { error: err.message });
        }
    }, 60 * 60 * 1000);
}
//# sourceMappingURL=dlq.js.map