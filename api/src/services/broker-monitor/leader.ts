/**
 * Redis-based leader election for the Broker Monitor service.
 * Only the replica holding the lock runs MQTTMonitorService.
 * Others return 503 from broker-monitor routes.
 */

import type Redis from 'ioredis';
import { getRedisClient } from '../../redis/client-factory';
import logger from '../../utils/logger';

const LEADER_KEY = 'broker-monitor:leader';
const TTL_SECONDS = 20;
const RENEW_INTERVAL_MS = 10_000;
const RETRY_INTERVAL_MS = 30_000;

export class BrokerMonitorLeader {
  private instanceId: string;
  private redis: Redis;
  private isLeader = false;
  private renewTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private onAcquiredCb: () => void;
  private onLostCb: () => void;
  private started = false;

  constructor(onAcquired: () => void, onLost: () => void) {
    this.instanceId = `api-${process.pid}-${Date.now()}`;
    this.redis = getRedisClient();
    this.onAcquiredCb = onAcquired;
    this.onLostCb = onLost;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    logger.info('BrokerMonitorLeader starting election', { instanceId: this.instanceId });
    await this.tryAcquire();
  }

  async release(): Promise<void> {
    this.started = false;
    this.clearTimers();

    if (this.isLeader) {
      try {
        // Only delete the key if we still own it (Lua script for atomicity)
        const script = `
          if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
          else
            return 0
          end
        `;
        await this.redis.eval(script, 1, LEADER_KEY, this.instanceId);
        logger.info('BrokerMonitorLeader released lock', { instanceId: this.instanceId });
      } catch (err: any) {
        logger.warn('BrokerMonitorLeader failed to release lock', { error: err.message });
      }
      this.isLeader = false;
    }
  }

  getIsLeader(): boolean {
    return this.isLeader;
  }

  private async tryAcquire(): Promise<void> {
    try {
      // SET key value EX ttl NX — only sets if key doesn't exist
      const result = await this.redis.set(LEADER_KEY, this.instanceId, 'EX', TTL_SECONDS, 'NX');
      if (result === 'OK') {
        this.becomeLeader();
      } else {
        this.scheduleRetry();
      }
    } catch (err: any) {
      logger.warn('BrokerMonitorLeader election attempt failed', { error: err.message });
      this.scheduleRetry();
    }
  }

  private becomeLeader(): void {
    this.isLeader = true;
    logger.info('BrokerMonitorLeader acquired lock', { instanceId: this.instanceId });
    this.onAcquiredCb();
    this.startRenewLoop();
  }

  private startRenewLoop(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);

    this.renewTimer = setInterval(async () => {
      try {
        // SET key value XX EX ttl — only renews if key already exists with our value
        const script = `
          if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("PEXPIRE", KEYS[1], ARGV[2])
          else
            return 0
          end
        `;
        const renewed = await this.redis.eval(
          script, 1, LEADER_KEY, this.instanceId, String(TTL_SECONDS * 1000)
        );

        if (!renewed) {
          logger.warn('BrokerMonitorLeader lost lock (not renewed)', { instanceId: this.instanceId });
          this.resignLeadership();
        }
      } catch (err: any) {
        logger.warn('BrokerMonitorLeader renew failed', { error: err.message });
        // Don't resign immediately on network glitch — TTL will expire naturally
      }
    }, RENEW_INTERVAL_MS);
  }

  private resignLeadership(): void {
    this.isLeader = false;
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    this.onLostCb();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.started) return;

    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.started && !this.isLeader) {
        await this.tryAcquire();
      }
    }, RETRY_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
