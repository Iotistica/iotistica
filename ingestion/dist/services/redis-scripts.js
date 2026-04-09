"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hIncrByAndExpire = hIncrByAndExpire;
exports.moveToDlqAtomic = moveToDlqAtomic;
const crypto_1 = require("crypto");
class RedisScript {
    script;
    numkeys;
    sha1;
    constructor(script, numkeys) {
        this.script = script;
        this.numkeys = numkeys;
        this.sha1 = (0, crypto_1.createHash)('sha1').update(script).digest('hex');
    }
    async exec(redis, keys, args) {
        const params = [...keys, ...args];
        try {
            return await redis.evalsha(this.sha1, this.numkeys, ...params);
        }
        catch (err) {
            if (!(err instanceof Error) || !err.message.includes('NOSCRIPT'))
                throw err;
            return redis.eval(this.script, this.numkeys, ...params);
        }
    }
}
const hIncrByAndExpireScript = new RedisScript(`local count = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return count`, 1);
async function hIncrByAndExpire(redis, key, field, ttlSeconds) {
    const result = await hIncrByAndExpireScript.exec(redis, [key], [field, String(ttlSeconds)]);
    return result;
}
const moveToDlqScript = new RedisScript(`local added = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[4], '*',
  'data', ARGV[3], 'original_id', ARGV[2], 'error', ARGV[5],
  'attempts', ARGV[6], 'failed_at', ARGV[7])
redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
redis.call('HDEL', KEYS[3], ARGV[2])
return added`, 3);
async function moveToDlqAtomic(redis, sourceStream, dlqStream, failureHash, consumerGroup, messageId, data, maxDlqLen, error, attempts, failedAt) {
    const result = await moveToDlqScript.exec(redis, [sourceStream, dlqStream, failureHash], [consumerGroup, messageId, data, String(maxDlqLen), error, String(attempts), failedAt]);
    return result;
}
//# sourceMappingURL=redis-scripts.js.map