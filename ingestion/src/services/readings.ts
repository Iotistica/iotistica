/**
 * Write-side readings service for ingestion.
 * Owns single-row and bulk persistence into TimescaleDB.
 */

import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { getClient, query } from '../db/connection';
import { getRedisClient } from '../redis/client-factory';
import logger from '../utils/logger';

export interface ReadingInsert {
  agent_uuid: string;  // AGENT/infrastructure UUID
  metric_name: string;
  value: number | null;
  quality?: string;
  unit?: string;
  protocol: string;
  extra?: ReadingExtra;  // endpoint_uuid, device_uuid (asset), device_name, protocol metadata
  extraJson?: string;             // Pre-serialized extra - set by normalizer to avoid JSON.stringify in hot loop
  detectionMethodsJson?: string;   // Pre-serialized detection_methods - set by normalizer to avoid JSON.stringify in hot loop
  time?: Date;
  anomaly_score?: number;
  anomaly_threshold?: number;
  baseline_samples?: number;
  detection_methods?: any;
}

export interface ReadingExtra {
  endpoint_uuid?: string;      // Endpoint/sensor UUID (connection point)
  device_uuid?: string;        // Stable device/asset UUID (business entity)
  device_name?: string;        // Device/asset name
  ingested_at?: string;        // ISO timestamp when ingested
  [key: string]: any;          // Protocol-specific metadata (slave_id, location, scale, etc)
}

/**
 * Insertion-order evicting set. Uses Map internals for O(1) has/add/evict.
 * Evicts the oldest (first-inserted) entry when the cap is reached, so the
 * cache stays warm instead of wiping everything at once.
 */
class LruSet {
  private readonly map = new Map<string, 1>();
  constructor(private readonly maxSize: number) {}

  has(key: string): boolean {
    return this.map.has(key);
  }

  add(key: string): void {
    if (this.map.has(key)) return;
    if (this.map.size >= this.maxSize) {
      // Map iterator yields keys in insertion order — delete the oldest.
      this.map.delete(this.map.keys().next().value!);
    }
    this.map.set(key, 1);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

export class ReadingsService {
  private static readonly VALID_BULK_INSERT_MODES = new Set(['copy', 'insert', 'realtime']);
  private static refreshInFlight: Promise<void> | null = null;
  private static lastRefreshAttemptAtMs = 0;
  private static readonly LOCAL_REFRESH_ATTEMPT_COOLDOWN_MS = 5000;
  // 10k entries × 3 sets ≈ 30k strings at ~50 bytes avg ≈ 1.5 MB worst-case.
  // LruSet evicts oldest entries individually — no mass-clear, no GC spike.
  private static readonly CATALOG_DISCOVERY_CACHE_MAX = 10000;
  private static readonly seenCatalogDevices = new LruSet(ReadingsService.CATALOG_DISCOVERY_CACHE_MAX);
  private static readonly seenCatalogMetrics = new LruSet(ReadingsService.CATALOG_DISCOVERY_CACHE_MAX);
  private static readonly seenCatalogDeviceMetrics = new LruSet(ReadingsService.CATALOG_DISCOVERY_CACHE_MAX);
  private static readonly COPY_TEMP_TABLE_NAME = 'tmp_readings_ingest';
  private static readonly COPY_TEMP_TABLE_READY_FLAG = Symbol('copy-temp-table-ready');
  // Shared Redis key: epoch-ms until which the catalog refresh lease is held.
  // Lets every pod skip the DB UPDATE round-trip when another pod already holds the lease.
  private static readonly REDIS_CATALOG_LEASE_KEY = 'catalog:refresh:lease_until_ms';

  // Lazily returns the shared singleton Redis client; returns null if Redis is unavailable
  // so that a Redis outage never breaks catalog refresh correctness.
  private static getRedis() {
    try { return getRedisClient(); } catch { return null; }
  }
  // 500 rows × 12 columns = 6 000 bind params per INSERT.
  // Keeps packets small, reduces lock hold time, and improves concurrency.
  private readonly MAX_ROWS_PER_BULK_INSERT = 500;
  private readonly REALTIME_ROWS_PER_INSERT = Math.max(
    1,
    Number.isFinite(parseInt(process.env.READINGS_REALTIME_ROWS_PER_INSERT || '25', 10))
      ? parseInt(process.env.READINGS_REALTIME_ROWS_PER_INSERT || '25', 10)
      : 25,
  );
  private readonly COPY_STAGE_ROWS_PER_BATCH = 5000;
  private readonly BULK_INSERT_MODE = this.resolveBulkInsertMode();
  private readonly COPY_MIN_ROWS = Math.max(
    1,
    Number.isFinite(parseInt(process.env.READINGS_COPY_MIN_ROWS || '1000', 10))
      ? parseInt(process.env.READINGS_COPY_MIN_ROWS || '1000', 10)
      : 1000,
  );
  private readonly REALTIME_MAX_ROWS = Math.max(
    1,
    Number.isFinite(parseInt(process.env.READINGS_REALTIME_MAX_ROWS || '50', 10))
      ? parseInt(process.env.READINGS_REALTIME_MAX_ROWS || '50', 10)
      : 50,
  );

  private resolveBulkInsertMode(): 'copy' | 'insert' | 'realtime' {
    const configuredMode = (process.env.READINGS_BULK_INSERT_MODE || 'copy').toLowerCase();
    if (ReadingsService.VALID_BULK_INSERT_MODES.has(configuredMode)) {
      return configuredMode as 'copy' | 'insert' | 'realtime';
    }

    logger.warn('Invalid READINGS_BULK_INSERT_MODE configured, defaulting to copy', {
      configuredMode,
    });
    return 'copy';
  }

  private escapeCopyText(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\t/g, '\\t')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  private copyValue(value: unknown): string {
    if (value === null || value === undefined) return '\\N';
    if (value instanceof Date) return this.escapeCopyText(value.toISOString());
    if (typeof value === 'string') return this.escapeCopyText(value);
    if (typeof value === 'number' || typeof value === 'boolean') return this.escapeCopyText(String(value));
    return this.escapeCopyText(JSON.stringify(value));
  }

  private toCopyLine(reading: ReadingInsert): string {
    const {
      agent_uuid,
      metric_name,
      value,
      quality = 'good',
      unit = null,
      protocol,
      extra = {},
      extraJson,
      time = new Date(),
      anomaly_score,
      anomaly_threshold,
      baseline_samples,
      detection_methods,
      detectionMethodsJson,
    } = reading;

    const fields = [
      this.copyValue(time),
      this.copyValue(agent_uuid),
      this.copyValue(metric_name),
      this.copyValue(value),
      this.copyValue(quality),
      this.copyValue(unit),
      this.copyValue(protocol),
      this.copyValue(extraJson ?? JSON.stringify(extra)),
      this.copyValue(anomaly_score !== undefined ? anomaly_score : null),
      this.copyValue(anomaly_threshold !== undefined ? anomaly_threshold : null),
      this.copyValue(baseline_samples !== undefined ? baseline_samples : null),
      this.copyValue(detectionMethodsJson ?? (detection_methods !== undefined ? JSON.stringify(detection_methods) : null)),
    ];

    return `${fields.join('\t')}\n`;
  }

  private async ensureCopyTempTable(client: PoolClient): Promise<void> {
    const trackedClient = client as PoolClient & {
      [ReadingsService.COPY_TEMP_TABLE_READY_FLAG]?: boolean;
    };

    if (trackedClient[ReadingsService.COPY_TEMP_TABLE_READY_FLAG]) {
      return;
    }

    await client.query(`
      CREATE TEMP TABLE IF NOT EXISTS ${ReadingsService.COPY_TEMP_TABLE_NAME} (
        time timestamptz,
        agent_uuid uuid,
        metric_name text,
        value double precision,
        quality text,
        unit text,
        protocol text,
        extra jsonb,
        anomaly_score double precision,
        anomaly_threshold double precision,
        baseline_samples integer,
        detection_methods jsonb
      )
    `);

    trackedClient[ReadingsService.COPY_TEMP_TABLE_READY_FLAG] = true;
  }

  private async bulkInsertViaCopy(readings: ReadingInsert[]): Promise<number> {
    let insertedTotal = 0;
    const client = await getClient();

    try {
      await this.ensureCopyTempTable(client);

      for (let i = 0; i < readings.length; i += this.COPY_STAGE_ROWS_PER_BATCH) {
        const batch = readings.slice(i, i + this.COPY_STAGE_ROWS_PER_BATCH);

        try {
          await client.query('BEGIN');
          await client.query(`TRUNCATE TABLE ${ReadingsService.COPY_TEMP_TABLE_NAME}`);

          const copySql = `
            COPY ${ReadingsService.COPY_TEMP_TABLE_NAME} (
              time, agent_uuid, metric_name, value, quality, unit, protocol,
              extra, anomaly_score, anomaly_threshold, baseline_samples, detection_methods
            )
            FROM STDIN WITH (FORMAT text)
          `;

          const copyStream = client.query(copyFrom(copySql));
          const batchSeen = new Set<string>();
          await pipeline(
            Readable.from((function* (this: ReadingsService) {
              for (const r of batch) {
                const key = `${r.agent_uuid}\t${r.metric_name}\t${(r.time ?? new Date()).getTime()}`;
                if (batchSeen.has(key)) continue;
                batchSeen.add(key);
                yield this.toCopyLine(r);
              }
            }).call(this)),
            copyStream as NodeJS.WritableStream,
          );

          const insertResult = await client.query(`
            INSERT INTO readings (
              time, agent_uuid, metric_name, value, quality, unit, protocol,
              extra, anomaly_score, anomaly_threshold, baseline_samples, detection_methods
            )
            SELECT
              time, agent_uuid, metric_name, value, quality, unit, protocol,
              extra, anomaly_score, anomaly_threshold, baseline_samples, detection_methods
            FROM ${ReadingsService.COPY_TEMP_TABLE_NAME}
            ON CONFLICT (agent_uuid, metric_name, time) DO NOTHING
          `);

          // Upsert latest values for Prometheus scrape (one row per series)
          await client.query(`
            INSERT INTO series_latest (
              agent_uuid, device_name, metric_name, value, quality, unit, protocol, time
            )
            SELECT DISTINCT ON (t.agent_uuid, COALESCE(t.extra->>'deviceName', 'unknown'), t.metric_name)
              t.agent_uuid,
              COALESCE(t.extra->>'deviceName', 'unknown'),
              t.metric_name,
              t.value,
              t.quality,
              t.unit,
              t.protocol,
              t.time
            FROM ${ReadingsService.COPY_TEMP_TABLE_NAME} t
            ORDER BY t.agent_uuid, COALESCE(t.extra->>'deviceName', 'unknown'), t.metric_name, t.time DESC
            ON CONFLICT (agent_uuid, device_name, metric_name) DO UPDATE SET
              value    = EXCLUDED.value,
              quality  = EXCLUDED.quality,
              unit     = EXCLUDED.unit,
              protocol = EXCLUDED.protocol,
              time     = EXCLUDED.time
            WHERE EXCLUDED.time >= series_latest.time
          `);

          insertedTotal += insertResult.rowCount || 0;
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }
    } finally {
      client.release();
    }

    return insertedTotal;
  }

  private noteCatalogCandidates(readings: ReadingInsert[]): boolean {
    let hasMeaningfulChange = false;

    for (const reading of readings) {
      const metric = reading.metric_name;
      if (metric && !ReadingsService.seenCatalogMetrics.has(metric)) {
        ReadingsService.seenCatalogMetrics.add(metric);
        hasMeaningfulChange = true;
      }

      const extra = reading.extra as any;
      const device =
        extra?.device_uuid
        || extra?.deviceUuid
        || extra?.device_name
        || extra?.deviceName
        || reading.agent_uuid;

      if (!device) {
        continue;
      }

      if (!ReadingsService.seenCatalogDevices.has(device)) {
        ReadingsService.seenCatalogDevices.add(device);
        hasMeaningfulChange = true;
      }

      if (!metric) {
        continue;
      }

      const deviceMetricKey = `${device}:${metric}`;
      if (!ReadingsService.seenCatalogDeviceMetrics.has(deviceMetricKey)) {
        ReadingsService.seenCatalogDeviceMetrics.add(deviceMetricKey);
        hasMeaningfulChange = true;
      }
    }

    return hasMeaningfulChange;
  }

  /**
   * Refresh materialized views (throttled)
   * Called after bulk insert when new device data is detected
   */
  private async refreshMetricCatalog(): Promise<void> {
    const now = Date.now();
    if (now - ReadingsService.lastRefreshAttemptAtMs < ReadingsService.LOCAL_REFRESH_ATTEMPT_COOLDOWN_MS) {
      return;
    }
    ReadingsService.lastRefreshAttemptAtMs = now;

    // Per-process guard: collapses concurrent calls within this pod into one
    // DB round trip. Cross-pod coordination is handled by the UPDATE throttle below.
    if (ReadingsService.refreshInFlight) {
      return;
    }

    ReadingsService.refreshInFlight = (async () => {
      let leaseAcquired = false;
      const redis = ReadingsService.getRedis();

      try {
        // Cross-pod pre-check: any pod that recently won the DB lease publishes its
        // expiry into Redis. A Redis GET here (~0.1 ms) replaces an unnecessary DB
        // UPDATE (~2–5 ms) on every non-winning pod, eliminating N-pod write storms.
        if (redis) {
          try {
            const leaseUntilMs = await redis.get(ReadingsService.REDIS_CATALOG_LEASE_KEY);
            if (leaseUntilMs && parseInt(leaseUntilMs, 10) > Date.now()) {
              logger.debug('Skipped metric catalog refresh - Redis lease cache indicates another pod holds the lease');
              return;
            }
          } catch {
            // Redis unavailable — fall through to DB check so correctness is preserved.
          }
        }

        // Distributed lease: one atomic UPDATE wins per window across all pods.
        // Claim holds the lease for 120 s — long enough to cover any normal refresh
        // duration. If the pod crashes mid-refresh the lease self-expires, so no
        // worker is blocked forever.
        const claimTime = Date.now();
        const claim = await query(
          `UPDATE refresh_control
             SET last_refresh = NOW(),
                 lease_until  = NOW() + interval '120 seconds'
           WHERE key = 'metric_catalog'
             AND NOW() > lease_until
           RETURNING 1`,
          []
        );

        if (claim.rowCount === 0) {
          logger.debug('Skipped metric catalog refresh - another worker holds the lease');
          return;
        }

        leaseAcquired = true;

        // Broadcast the lease acquisition so other pods exit on the Redis pre-check
        // instead of hitting the DB. Fire-and-forget — non-critical.
        if (redis) {
          redis
            .set(ReadingsService.REDIS_CATALOG_LEASE_KEY, String(claimTime + 120_000), 'EX', 120)
            .catch(() => undefined);
        }

        await query('SELECT refresh_all_catalog_views()', []);
        logger.debug('Refreshed metric catalog views');
      } catch (error) {
        logger.error('Failed to refresh metric catalog views:', error);
      } finally {
        if (leaseAcquired) {
          // Release early: whether refresh succeeded or failed, transition from the
          // active lock (120 s) to the throttle window (60 s). This unblocks other
          // pods promptly while still preventing an immediate retry storm.
          if (redis) {
            redis
              .set(ReadingsService.REDIS_CATALOG_LEASE_KEY, String(Date.now() + 60_000), 'EX', 60)
              .catch(() => undefined);
          }
          await query(
            `UPDATE refresh_control
               SET lease_until = NOW() + interval '60 seconds'
             WHERE key = 'metric_catalog'`,
            []
          ).catch(err => logger.warn('Failed to release refresh lease:', err));
        }
      }
    })().finally(() => {
      ReadingsService.refreshInFlight = null;
    });

    await ReadingsService.refreshInFlight;
  }

  /**
   * Insert single reading
   */
  async insert(reading: ReadingInsert): Promise<void> {
    const {
      agent_uuid,
      metric_name,
      value,
      quality = 'good',
      unit = null,
      protocol,
      extra = {},
      time = new Date()
    } = reading;

    await query(
      `INSERT INTO readings (time, agent_uuid, metric_name, value, quality, unit, protocol, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_uuid, metric_name, time) DO NOTHING`,
      [time, agent_uuid, metric_name, value, quality, unit, protocol, JSON.stringify(extra)]
    );
  }

  private async bulkInsertViaValues(readings: ReadingInsert[], maxRowsPerInsert: number): Promise<number> {
    let insertedTotal = 0;
    const insertClient = await getClient();

    try {
      for (let i = 0; i < readings.length; i += maxRowsPerInsert) {
        const batch = readings.slice(i, i + maxRowsPerInsert);
        const values: unknown[] = [];
        const placeholders: string[] = [];
        let paramIndex = 1;

        batch.forEach((reading) => {
          const {
            agent_uuid,
            metric_name,
            value,
            quality = 'good',
            unit = null,
            protocol,
            extra = {},
            extraJson,
            detectionMethodsJson,
            time = new Date(),
            anomaly_score,
            anomaly_threshold,
            baseline_samples,
            detection_methods,
          } = reading;

          placeholders.push(
            `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
          );

          values.push(
            time,
            agent_uuid,
            metric_name,
            value,
            quality,
            unit,
            protocol,
            extraJson ?? JSON.stringify(extra),
            anomaly_score !== undefined ? anomaly_score : null,
            anomaly_threshold !== undefined ? anomaly_threshold : null,
            baseline_samples !== undefined ? baseline_samples : null,
            detectionMethodsJson ?? (detection_methods !== undefined ? JSON.stringify(detection_methods) : null),
          );
        });

        const result = await insertClient.query(
          `INSERT INTO readings (time, agent_uuid, metric_name, value, quality, unit, protocol, extra, anomaly_score, anomaly_threshold, baseline_samples, detection_methods)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (agent_uuid, metric_name, time) DO NOTHING`,
          values,
        );

        insertedTotal += result.rowCount || 0;

        // Upsert latest values for Prometheus scrape (one row per series)
        await this.upsertSeriesLatest(insertClient, batch);
      }
    } finally {
      insertClient.release();
    }

    return insertedTotal;
  }

  /**
   * Upsert latest value per series into series_latest for Prometheus scrape.
   * Deduplicates within batch (keeps newest time per series key).
   */
  private async upsertSeriesLatest(client: PoolClient, batch: ReadingInsert[]): Promise<void> {
    // Deduplicate: keep only the newest reading per (agent_uuid, device_name, metric_name)
    const latest = new Map<string, ReadingInsert>();
    for (const r of batch) {
      const deviceName = (r.extra as any)?.deviceName || (r.extra as any)?.device_name || 'unknown';
      const key = `${r.agent_uuid}\t${deviceName}\t${r.metric_name}`;
      const existing = latest.get(key);
      if (!existing || (r.time ?? new Date()) > (existing.time ?? new Date())) {
        latest.set(key, r);
      }
    }

    const rows = [...latest.values()];
    if (rows.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const r of rows) {
      const deviceName = (r.extra as any)?.deviceName || (r.extra as any)?.device_name || 'unknown';
      placeholders.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
      );
      values.push(
        r.agent_uuid,
        deviceName,
        r.metric_name,
        r.value,
        r.quality || 'good',
        r.unit || null,
        r.protocol,
        r.time ?? new Date(),
      );
    }

    await client.query(
      `INSERT INTO series_latest (agent_uuid, device_name, metric_name, value, quality, unit, protocol, time)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (agent_uuid, device_name, metric_name) DO UPDATE SET
         value    = EXCLUDED.value,
         quality  = EXCLUDED.quality,
         unit     = EXCLUDED.unit,
         protocol = EXCLUDED.protocol,
         time     = EXCLUDED.time
       WHERE EXCLUDED.time >= series_latest.time`,
      values,
    );
  }

  /**
   * Bulk insert readings (more efficient)
   */
  async bulkInsert(readings: ReadingInsert[]): Promise<number> {
    if (readings.length === 0) return 0;

    let insertedTotal = 0;
    let copySucceeded = false;
    const useRealtimeInsertPath = this.BULK_INSERT_MODE === 'realtime'
      || (this.BULK_INSERT_MODE === 'copy' && readings.length <= this.REALTIME_MAX_ROWS);

    if (useRealtimeInsertPath) {
      insertedTotal = await this.bulkInsertViaValues(readings, this.REALTIME_ROWS_PER_INSERT);
    }

    const copyEnabled = this.BULK_INSERT_MODE === 'copy' && !useRealtimeInsertPath;
    if (copyEnabled && readings.length >= this.COPY_MIN_ROWS) {
      try {
        insertedTotal = await this.bulkInsertViaCopy(readings);
        copySucceeded = true;
      } catch (error) {
        logger.warn('COPY ingest path failed; falling back to INSERT batching', {
          error: (error as Error).message,
          readings: readings.length,
        });
      }
    }

    if (!copySucceeded && !useRealtimeInsertPath) {
      insertedTotal = await this.bulkInsertViaValues(readings, this.MAX_ROWS_PER_BULK_INSERT);
    }

    // Upsert series_latest for non-COPY paths (COPY path handles it inline via temp table)
    if (!copySucceeded && insertedTotal > 0) {
      const client = await getClient();
      try {
        await this.upsertSeriesLatest(client, readings);
      } catch (err) {
        logger.warn('series_latest upsert failed', { error: (err as Error).message });
      } finally {
        client.release();
      }
    }

    // Refresh only when newly observed catalog dimensions appear in this pod:
    // new device, new metric, or new (device, metric) pair.
    const hasMeaningfulCatalogChange = this.noteCatalogCandidates(readings);
    if (hasMeaningfulCatalogChange && insertedTotal > 0) {
      // Fire-and-forget (don't block on refresh)
      this.refreshMetricCatalog().catch(err => 
        logger.error('Background metric catalog refresh failed:', err)
      );
    }

    return insertedTotal;
  }
}

export const readingsService = new ReadingsService();
