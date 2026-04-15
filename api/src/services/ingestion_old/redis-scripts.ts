import { createHash } from 'crypto';
import type Redis from 'ioredis';

/**
 * Lightweight EVALSHA-with-EVAL-fallback wrapper.
 *
 * The SHA1 is computed once at module load time from the script text. Every call
 * tries EVALSHA first (a hash-table lookup in Redis — much cheaper than sending
 * the full script body). On NOSCRIPT (e.g. Redis restarted and flushed the script
 * cache), it falls back to EVAL transparently so the caller never needs to handle
 * that case.
 */
class RedisScript {
  private readonly sha1: string;

  constructor(
    private readonly script: string,
    private readonly numkeys: number,
  ) {
    this.sha1 = createHash('sha1').update(script).digest('hex');
  }

  async exec(redis: Redis, keys: string[], args: string[]): Promise<unknown> {
    const params: Array<string | number> = [...keys, ...args];
    try {
      return await redis.evalsha(this.sha1, this.numkeys, ...params);
    } catch (err: unknown) {
      if (!(err instanceof Error) || !err.message.includes('NOSCRIPT')) throw err;
      return redis.eval(this.script, this.numkeys, ...params);
    }
  }
}

// ---------------------------------------------------------------------------
// Script 1: HINCRBY + EXPIRE atomically (2 RTTs → 1)
//
// KEYS[1] = hash key
// ARGV[1] = field
// ARGV[2] = TTL in seconds
// Returns: new integer count
// ---------------------------------------------------------------------------
const hIncrByAndExpireScript = new RedisScript(
  `local count = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return count`,
  1,
);

/**
 * Atomically increment a hash field by 1 and refresh the hash TTL.
 * Replaces the two-round-trip HINCRBY + EXPIRE pattern with a single EVALSHA.
 */
export async function hIncrByAndExpire(
  redis: Redis,
  key: string,
  field: string,
  ttlSeconds: number,
): Promise<number> {
  const result = await hIncrByAndExpireScript.exec(redis, [key], [field, String(ttlSeconds)]);
  return result as number;
}

// ---------------------------------------------------------------------------
// Script 2: Atomic DLQ move (XADD + XACK + HDEL, 3 RTTs → 1)
//
// KEYS[1] = source stream key (for XACK)
// KEYS[2] = DLQ stream key (for XADD)
// KEYS[3] = failure-tracking hash key (for HDEL)
// ARGV[1] = consumer group
// ARGV[2] = original message ID (to XACK)
// ARGV[3] = serialized entry data (JSON)
// ARGV[4] = maxDlqLen (approximate MAXLEN ~)
// ARGV[5] = error message
// ARGV[6] = attempt count
// ARGV[7] = failed_at ISO timestamp
//
// Returns: the new DLQ stream entry ID, or a Redis bulk-string error if XADD fails.
//
// Atomicity guarantee: if XADD fails (e.g. OOM), the script errors out before
// XACK/HDEL run — the original message stays in the PEL for retry and is never
// lost. The previous three-step approach had a window where XADD could succeed
// but XACK could fail, causing infinite PEL redelivery with duplicate DLQ entries.
// ---------------------------------------------------------------------------
const moveToDlqScript = new RedisScript(
  `local added = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[4], '*',
  'data', ARGV[3], 'original_id', ARGV[2], 'error', ARGV[5],
  'attempts', ARGV[6], 'failed_at', ARGV[7])
redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
redis.call('HDEL', KEYS[3], ARGV[2])
return added`,
  3,
);

/**
 * Atomically write a message to the DLQ, ACK it from the source stream, and
 * remove it from the failure-tracking hash — all in a single EVALSHA round trip.
 *
 * Returns the new DLQ stream entry ID on success.
 * Throws if XADD fails (caller should log and leave the message in the PEL).
 */
export async function moveToDlqAtomic(
  redis: Redis,
  sourceStream: string,
  dlqStream: string,
  failureHash: string,
  consumerGroup: string,
  messageId: string,
  data: string,
  maxDlqLen: number,
  error: string,
  attempts: number,
  failedAt: string,
): Promise<string> {
  const result = await moveToDlqScript.exec(
    redis,
    [sourceStream, dlqStream, failureHash],
    [consumerGroup, messageId, data, String(maxDlqLen), error, String(attempts), failedAt],
  );
  return result as string;
}
