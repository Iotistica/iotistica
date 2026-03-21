/**
 * Traffic Stats Flush Service
 * 
 * Periodically flushes in-memory device traffic statistics to PostgreSQL
 * using time-series buckets for efficient historical storage.
 * 
 * Features:
 * - Hourly time bucketing for aggregation
 * - Upsert on conflict to merge data
 * - Automatic cleanup of old data (configurable retention)
 * - Graceful shutdown handling
 */

import poolWrapper from '../db/connection';
import { getTrafficStats } from '../middleware/traffic-logger';
import { logger } from '../utils/logger';

// Configuration
const FLUSH_INTERVAL_MS = parseInt(process.env.TRAFFIC_FLUSH_INTERVAL || '900000'); // 15 minutes default
const RETENTION_DAYS = parseInt(process.env.TRAFFIC_RETENTION_DAYS || '90'); // 90 days default
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Run cleanup once per day

let flushInterval: NodeJS.Timeout | null = null;
let cleanupInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;

/**
 * Truncate timestamp to hourly bucket
 */
function getHourlyBucket(date: Date = new Date()): Date {
  const bucket = new Date(date);
  bucket.setMinutes(0, 0, 0);
  return bucket;
}

/**
 * Flush current in-memory stats to database
 */
export async function flushTrafficStats(): Promise<void> {
  if (isShuttingDown) {
    logger.info('[TrafficFlush] Skipping flush during shutdown');
    return;
  }

  const stats = getTrafficStats();
  
  if (stats.length === 0) {
    logger.debug('[TrafficFlush] No stats to flush');
    return;
  }

  const timeBucket = getHourlyBucket();
  
  logger.info(`[TrafficFlush] Flushing ${stats.length} entries to database`);

  try {
    // Use transaction for atomic upsert
    await poolWrapper.transaction(async (client) => {
      for (const stat of stats) {
        // Upsert: insert or update on conflict
        await client.query(`
          INSERT INTO agent_traffic_stats (
            device_id,
            endpoint,
            method,
            time_bucket,
            request_count,
            total_bytes,
            total_time,
            success_count,
            failed_count,
            status_codes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          ON CONFLICT (device_id, endpoint, method, time_bucket)
          DO UPDATE SET
            request_count = agent_traffic_stats.request_count + EXCLUDED.request_count,
            total_bytes = agent_traffic_stats.total_bytes + EXCLUDED.total_bytes,
            total_time = agent_traffic_stats.total_time + EXCLUDED.total_time,
            success_count = agent_traffic_stats.success_count + EXCLUDED.success_count,
            failed_count = agent_traffic_stats.failed_count + EXCLUDED.failed_count,
            status_codes = (
              SELECT jsonb_object_agg(
                key,
                COALESCE((agent_traffic_stats.status_codes->>key)::int, 0) + 
                COALESCE((EXCLUDED.status_codes->>key)::int, 0)
              )
              FROM (
                SELECT key FROM jsonb_object_keys(agent_traffic_stats.status_codes) AS key
                UNION
                SELECT key FROM jsonb_object_keys(EXCLUDED.status_codes) AS key
              ) AS all_keys
            ),
            updated_at = NOW()
        `, [
          stat.deviceId,
          stat.endpoint,
          stat.method,
          timeBucket,
          stat.count,
          stat.totalBytes,
          stat.totalTime,
          stat.success,
          stat.failed,
          JSON.stringify(stat.statuses)
        ]);
      }
    });

    logger.info(`[TrafficFlush] Successfully flushed ${stats.length} entries`);
  } catch (error) {
    logger.error('[TrafficFlush] Failed to flush stats:', error);
    throw error;
  }
}

/**
 * Clean up old traffic stats based on retention policy
 */
export async function cleanupOldStats(): Promise<void> {
  if (isShuttingDown) {
    logger.info('[TrafficCleanup] Skipping cleanup during shutdown');
    return;
  }
  
  try {
    logger.info(`[TrafficCleanup] Cleaning up stats older than ${RETENTION_DAYS} days`);
    
    const result = await poolWrapper.query('SELECT cleanup_old_traffic_stats($1)', [RETENTION_DAYS]);
    const deletedCount = result.rows[0]?.cleanup_old_traffic_stats || 0;
    
    if (deletedCount > 0) {
      logger.info(`[TrafficCleanup] Deleted ${deletedCount} old records`);
    } else {
      logger.debug('[TrafficCleanup] No old records to delete');
    }
  } catch (error) {
    logger.error('[TrafficCleanup] Failed to cleanup old stats:', error);
  }
}

/**
 * Start the periodic flush service
 */
export function startTrafficFlushService(): void {
  if (flushInterval) {
    logger.warn('[TrafficFlush] Service already running');
    return;
  }

  logger.info(`[TrafficFlush] Starting service (interval: ${FLUSH_INTERVAL_MS}ms, retention: ${RETENTION_DAYS} days)`);

  // Initial flush after 1 minute
  setTimeout(() => {
    flushTrafficStats().catch(err => 
      logger.error('[TrafficFlush] Initial flush failed:', err)
    );
  }, 60000);

  // Periodic flush
  flushInterval = setInterval(() => {
    flushTrafficStats().catch(err => 
      logger.error('[TrafficFlush] Periodic flush failed:', err)
    );
  }, FLUSH_INTERVAL_MS);

  // Initial cleanup after 5 minutes
  setTimeout(() => {
    cleanupOldStats().catch(err => 
      logger.error('[TrafficCleanup] Initial cleanup failed:', err)
    );
  }, 300000);

  // Periodic cleanup (daily)
  cleanupInterval = setInterval(() => {
    cleanupOldStats().catch(err => 
      logger.error('[TrafficCleanup] Periodic cleanup failed:', err)
    );
  }, CLEANUP_INTERVAL_MS);

  logger.info('[TrafficFlush] Service started successfully');
}

/**
 * Stop the periodic flush service
 */
export async function stopTrafficFlushService(): Promise<void> {
  isShuttingDown = true;
  
  logger.info('[TrafficFlush] Stopping service...');

  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  // Final flush before shutdown
  try {
    logger.info('[TrafficFlush] Performing final flush before shutdown');
    await flushTrafficStats();
    logger.info('[TrafficFlush] Service stopped successfully');
  } catch (error) {
    logger.error('[TrafficFlush] Final flush failed:', error);
  }
}

/**
 * Manual flush trigger (for testing or admin purposes)
 */
export async function manualFlush(): Promise<{ success: boolean; flushed: number; error?: string }> {
  try {
    const stats = getTrafficStats();
    const count = stats.length;
    
    await flushTrafficStats();
    
    return { success: true, flushed: count };
  } catch (error: any) {
    return { success: false, flushed: 0, error: error.message };
  }
}
