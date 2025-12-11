/**
 * Log Batch Queue Service
 * 
 * Collects logs from ALL devices in a single global queue and writes to 
 * database in batches to reduce database connection pressure and improve 
 * write performance.
 * 
 * Features:
 * - Global batching across all devices
 * - Configurable batch size (default: 20 logs)
 * - Configurable flush interval (default: 5 seconds)
 * - Automatic flush on graceful shutdown
 * - Minimum batch size to avoid small flushes
 */

import { DeviceLogsModel } from '../db/models';
import { logger } from '../utils/logger';

interface LogEntry {
  deviceUuid: string;
  serviceName?: string;
  timestamp?: Date;
  message: string;
  level?: string;
  isSystem?: boolean;
  isStderr?: boolean;
}

class LogBatchQueue {
  private logs: LogEntry[] = [];
  private timer?: NodeJS.Timeout;
  private batchSize: number;
  private minBatchSize: number;
  private flushIntervalMs: number;
  private maxTotalLogs: number;
  private isShuttingDown: boolean = false;
  private isFlushing: boolean = false;

  constructor() {
    // Get config from environment
    this.batchSize = parseInt(process.env.LOG_BATCH_SIZE || '20', 10);
    this.minBatchSize = parseInt(process.env.LOG_MIN_BATCH_SIZE || '5', 10);
    this.flushIntervalMs = parseInt(process.env.LOG_FLUSH_INTERVAL_MS || '5000', 10);
    this.maxTotalLogs = parseInt(process.env.LOG_MAX_TOTAL_QUEUED || '5000', 10);

    logger.info('Log Batch Queue initialized (GLOBAL batching)', {
      batchSize: this.batchSize,
      minBatchSize: this.minBatchSize,
      flushIntervalMs: this.flushIntervalMs,
      maxTotalLogs: this.maxTotalLogs
    });
  }

  /**
   * Add logs to the global queue
   */
  async add(deviceUuid: string, logs: Array<{
    serviceName?: string;
    timestamp?: Date;
    message: string;
    level?: string;
    isSystem?: boolean;
    isStderr?: boolean;
  }>): Promise<void> {
    if (this.isShuttingDown) {
      // During shutdown, write immediately
      await this.flush();
      return;
    }

    // Check total memory usage before adding
    if (this.logs.length + logs.length > this.maxTotalLogs) {
      logger.warn('Log queue memory limit reached, flushing', {
        currentTotal: this.logs.length,
        incoming: logs.length,
        limit: this.maxTotalLogs
      });
      
      // Flush current queue to make room
      await this.flush();
    }

    // Add logs to global queue with device UUID
    const logsWithDevice = logs.map(log => ({
      deviceUuid,
      ...log
    }));
    this.logs.push(...logsWithDevice);

    // Clear existing timer and start a new one (reset the flush countdown)
    if (this.timer) {
      clearTimeout(this.timer);
    }
    
    this.timer = setTimeout(() => {
      // Only flush on timer if we have minimum batch size
      if (this.logs.length >= this.minBatchSize) {
        this.flush().catch(err => {
          logger.error('Error flushing logs on timer', { error: err.message });
        });
      } else {
        // Not enough logs yet, restart timer
        this.timer = setTimeout(() => {
          this.flush().catch(err => {
            logger.error('Error flushing logs on timer', { error: err.message });
          });
        }, this.flushIntervalMs);
      }
    }, this.flushIntervalMs);

    // Flush immediately if batch size reached
    if (this.logs.length >= this.batchSize) {
      await this.flush();
    }
  }

  /**
   * Flush all queued logs to database
   */
  private async flush(): Promise<void> {
    if (this.logs.length === 0 || this.isFlushing) {
      return;
    }

    this.isFlushing = true;

    // Clear timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // Get logs and clear queue
    const logsToWrite = [...this.logs];
    this.logs = [];

    try {
      const startTime = Date.now();
      
      // Group logs by device for efficient insertion
      const logsByDevice = new Map<string, typeof logsToWrite>();
      for (const log of logsToWrite) {
        if (!logsByDevice.has(log.deviceUuid)) {
          logsByDevice.set(log.deviceUuid, []);
        }
        logsByDevice.get(log.deviceUuid)!.push(log);
      }

      // Write all devices in parallel
      await Promise.all(
        Array.from(logsByDevice.entries()).map(async ([deviceUuid, deviceLogs]) => {
          // Remove deviceUuid from log objects before storing
          const cleanedLogs = deviceLogs.map(({ deviceUuid, ...rest }) => rest);
          await DeviceLogsModel.store(deviceUuid, cleanedLogs, cleanedLogs.length);
        })
      );

      const duration = Date.now() - startTime;
      logger.info('Flushed log batch to database', {
        totalLogs: logsToWrite.length,
        devices: logsByDevice.size,
        durationMs: duration,
        logsPerSecond: Math.round((logsToWrite.length / duration) * 1000)
      });

    } catch (error: any) {
      logger.error('Failed to flush logs to database', {
        count: logsToWrite.length,
        error: error.message
      });

      // Put logs back in queue for retry
      this.logs.unshift(...logsToWrite);
      
      // Schedule retry after 10 seconds
      this.timer = setTimeout(() => {
        this.flush().catch(err => {
          logger.error('Retry flush failed', { error: err.message });
        });
      }, 10000);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Flush all queued logs (called during shutdown)
   */
  async flushAll(): Promise<void> {
    this.isShuttingDown = true;

    logger.info('Flushing all queued logs...', {
      totalLogs: this.logs.length
    });

    await this.flush();

    logger.info('All logs flushed');
  }

  /**
   * Get queue statistics
   */
  getStats() {
    // Group by device for stats
    const deviceCounts = new Map<string, number>();
    for (const log of this.logs) {
      deviceCounts.set(log.deviceUuid, (deviceCounts.get(log.deviceUuid) || 0) + 1);
    }

    return {
      totalQueuedLogs: this.logs.length,
      deviceCount: deviceCounts.size,
      devices: Array.from(deviceCounts.entries()).map(([uuid, count]) => ({
        deviceUuid: uuid.substring(0, 8),
        logCount: count
      }))
    };
  }
}

// Singleton instance
export const logBatchQueue = new LogBatchQueue();
