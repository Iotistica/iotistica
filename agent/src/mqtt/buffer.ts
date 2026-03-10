/**
 * Message Buffer Sync Service
 * ===========================
 * 
 * Manages local message data buffer and syncs to MQTT when connection is available.
 * Implements offline queue pattern from AWS IoT Greengrass and Azure IoT Edge.
 * 
 * Features:
 * - Automatic flush on MQTT connect/reconnect
 * - Batch processing with configurable size
 * - Exponential backoff on failures
 * - Periodic cleanup of expired records
 * - Statistics tracking
 */

import type { MqttManager } from './manager';
import { createJsonPayload, serializePayload } from './manager';
import { MessageBufferModel } from '../db/models';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { IClientPublishOptions } from 'mqtt';

export interface BufferSyncConfig {
  enabled: boolean;
  flushBatchSize: number; // How many records to process per batch
  flushIntervalMs: number; // How often to attempt flush when online
  maxRetries: number; // Max retries per message before dropping
  cleanupIntervalMs: number; // How often to cleanup expired records
}

export type MessageBufferSyncOptions = BufferSyncConfig;

export class MessageBufferSync {
  private config: BufferSyncConfig;
  private mqttManager: MqttManager;
  private logger?: AgentLogger;
  
  private flushIntervalHandle?: NodeJS.Timeout;
  private cleanupIntervalHandle?: NodeJS.Timeout;
  private isFlushRequested = false;
  private isFlushing = false;
  private started = false;
  private readonly connectListener = () => {
    this.flushNow();
  };

  constructor(
    mqttManager: MqttManager,
    logger?: AgentLogger,
    config?: Partial<BufferSyncConfig>
  ) {
    this.mqttManager = mqttManager;
    this.logger = logger;
    
    this.config = {
      enabled: true,
      flushBatchSize: 100,
      flushIntervalMs: 30000, // 30 seconds
      maxRetries: 3,
      cleanupIntervalMs: 3600000, // 1 hour
      ...config
    };
  }

  /**
   * Start buffer sync service
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    if (!this.config.enabled) {
      this.logger?.infoSync('Message buffer sync disabled', {
        component: LogComponents.agent
      });
      return;
    }

    this.logger?.infoSync('Starting message buffer sync service', {
      component: LogComponents.agent,
      flushInterval: `${this.config.flushIntervalMs}ms`,
      batchSize: this.config.flushBatchSize
    });

    // Flush immediately whenever MQTT connection is re-established.
    this.mqttManager.on('connect', this.connectListener);

    // Start periodic flush timer
    this.flushIntervalHandle = setInterval(
      () => this.periodicFlush(),
      this.config.flushIntervalMs
    );

    // Start periodic cleanup timer
    this.cleanupIntervalHandle = setInterval(
      () => this.cleanupExpired(),
      this.config.cleanupIntervalMs
    );

    // Initial flush if MQTT already connected
    if (this.mqttManager.isConnected()) {
      await this.flushBuffer();
    }

    // Initial cleanup
    await this.cleanupExpired();

    this.started = true;
  }

  /**
   * Stop buffer sync service
   */
  stop(): void {
    if (!this.started) {
      return;
    }

    this.logger?.infoSync('Stopping message buffer sync service', {
      component: LogComponents.agent
    });

    this.mqttManager.off('connect', this.connectListener);

    if (this.flushIntervalHandle) {
      clearInterval(this.flushIntervalHandle);
      this.flushIntervalHandle = undefined;
    }

    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = undefined;
    }

    this.started = false;
  }

  /**
   * Return whether this buffer sync instance is enabled by config.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Intercept publish calls so offline payloads are persisted to SQLite.
   * Returns true when publish was fully handled by buffer storage.
   */
  async handlePublish(
    topic: string,
    payload: Buffer,
    options?: IClientPublishOptions
  ): Promise<boolean> {
    if (!this.config.enabled) {
      return false;
    }

    if (this.mqttManager.isConnected()) {
      return false;
    }

    await MessageBufferModel.enqueue({
      endpoint_name: this.extractEndpointName(topic),
      topic,
      qos: options?.qos ?? 0,
      payload: payload.toString('utf-8'),
      payload_bytes: payload.length,
    });

    this.logger?.debugSync('Buffered MQTT publish while offline', {
      component: LogComponents.agent,
      topic,
      payloadBytes: payload.length,
      qos: options?.qos ?? 0
    });

    return true;
  }

  /**
   * Request immediate flush (non-blocking)
   */
  requestFlush(): void {
    this.isFlushRequested = true;
  }

  /**
   * Get buffer statistics
   */
  async getStats() {
    return await MessageBufferModel.getStats();
  }

  private flushNow(): void {
    this.logger?.infoSync('MQTT connected - initiating buffer flush', {
      component: LogComponents.agent
    });
    
    // Trigger immediate flush
    this.requestFlush();
  }

  /**
   * Periodic flush attempt
   */
  private async periodicFlush(): Promise<void> {
    // Skip if already flushing or no flush requested
    if (this.isFlushing) return;
    
    // Only flush if requested OR MQTT is connected
    if (!this.isFlushRequested && !this.mqttManager.isConnected()) {
      return;
    }

    await this.flushBuffer();
  }

  /**
   * Flush buffered messages to MQTT
   */
  private async flushBuffer(): Promise<void> {
    if (this.isFlushing) {
      this.logger?.debugSync('Flush already in progress, skipping', {
        component: LogComponents.agent
      });
      return;
    }

    if (!this.mqttManager.isConnected()) {
      this.logger?.debugSync('MQTT not connected, skipping flush', {
        component: LogComponents.agent
      });
      return;
    }

    this.isFlushing = true;
    this.isFlushRequested = false;

    try {
      let totalFlushed = 0;
      let hasMore = true;

      // Process in batches until queue is empty
      while (hasMore && this.mqttManager.isConnected()) {
        const records = await MessageBufferModel.dequeueOldest(this.config.flushBatchSize);
        
        if (records.length === 0) {
          hasMore = false;
          break;
        }

        const successfulIds: number[] = [];
        const failedRecords: Array<{ id: number; error: string }> = [];

        // Publish each message
        for (const record of records) {
          try {
            // Try to parse as JSON and inject msgId for deduplication
            let payload: Buffer | string = record.payload;
            try {
              const json = JSON.parse(record.payload);
              const msgIdGen = this.mqttManager.getMessageIdGenerator();
              const mqttPayload = createJsonPayload(json, msgIdGen);
              payload = serializePayload(mqttPayload);
            } catch {
              // Not JSON - use as-is (Buffer or string)
            }
            
            await this.mqttManager.publish(
              record.topic,
              payload,
              { qos: record.qos as 0 | 1 | 2 }
            );
            
            successfulIds.push(record.id!);
          } catch (error: any) {
            const errorMsg = error?.message || String(error);
            
            // Check if message should be retried or dropped
            if (record.retry_count >= this.config.maxRetries) {
              this.logger?.warnSync('Message exceeded max retries, dropping', {
                component: LogComponents.agent,
                recordId: record.id,
                endpoint: record.endpoint_name,
                retries: record.retry_count,
                error: errorMsg
              });
              
              successfulIds.push(record.id!); // Delete it
            } else {
              failedRecords.push({ id: record.id!, error: errorMsg });
            }
          }
        }

        // Delete successfully published records
        if (successfulIds.length > 0) {
          await MessageBufferModel.deleteByIds(successfulIds);
          totalFlushed += successfulIds.length;
        }

        // Mark failed records for retry
        for (const failed of failedRecords) {
          await MessageBufferModel.markRetryFailed(failed.id, failed.error);
        }

        // Log batch progress
        if (records.length > 0) {
          this.logger?.infoSync('Buffer flush batch completed', {
            component: LogComponents.agent,
            processed: records.length,
            successful: successfulIds.length,
            failed: failedRecords.length,
            totalFlushed
          });
        }
      }

      if (totalFlushed > 0) {
        this.logger?.infoSync('Buffer flush completed', {
          component: LogComponents.agent,
          totalFlushed
        });
      }

    } catch (error: any) {
      this.logger?.errorSync(
        'Buffer flush failed',
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agent
        }
      );
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Cleanup expired records
   */
  private async cleanupExpired(): Promise<void> {
    try {
      const deleted = await MessageBufferModel.cleanupExpired();
      
      if (deleted > 0) {
        this.logger?.infoSync('Cleaned up expired buffer records', {
          component: LogComponents.agent,
          deleted
        });
      }
    } catch (error: any) {
      this.logger?.errorSync(
        'Cleanup failed',
        error instanceof Error ? error : new Error(String(error)),
        {
          component: LogComponents.agent
        }
      );
    }
  }

  private extractEndpointName(topic: string): string {
    const parts = topic.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
  }
}
