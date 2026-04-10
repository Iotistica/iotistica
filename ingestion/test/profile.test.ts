import test from 'node:test';
import assert from 'node:assert/strict';
import profileCatalogData from '../src/config/profile-catalog.json';

import {
  applyIngestionProfileForEnv,
  validateProfileCatalog,
} from '../src/config/profile';

test('validateProfileCatalog rejects unsupported keys', () => {
  const invalidCatalog = JSON.parse(JSON.stringify(profileCatalogData)) as Record<string, Record<string, string>>;
  invalidCatalog.batch.INVALID_KEY = '1';

  assert.throws(() => validateProfileCatalog(invalidCatalog, 'test-catalog'), /INVALID_KEY/);
});

test('applyIngestionProfileForEnv applies catalog defaults and preserves explicit overrides', () => {
  const catalog = validateProfileCatalog({
    batch: {
      REDIS_PIPELINE_FLUSH_INTERVAL_MS: '50',
      REDIS_INGESTION_STREAM_MAXLEN: '10000',
      REDIS_IDLE_INGESTION_STREAM_MAXLEN: '1000',
      REDIS_DLQ_MAXLEN: '1000',
      REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT: '0.8',
      REDIS_MEMORY_HIGH_WATERMARK_PCT: '75',
      WORKER_COUNT: '4',
      BATCH_SIZE: '500',
      FLUSH_INTERVAL_MS: '2000',
      AUTOSCALE_MIN_WORKERS: '2',
      AUTOSCALE_MAX_WORKERS: '12',
      AUTOSCALE_LAG_TARGET_MS: '10000',
      AUTOSCALE_LAG_SCALE_UP_MS: '5000',
      AUTOSCALE_LAG_CRITICAL_MS: '15000',
      AUTOSCALE_SCALE_DOWN_STABLE_CHECKS: '12',
      AUTOSCALE_COOLDOWN_MS: '5000',
      AUTOSCALE_DB_BLOCK_PCT: '80',
      READINGS_BULK_INSERT_MODE: 'copy',
      READINGS_COPY_MIN_ROWS: '1000',
      READINGS_REALTIME_MAX_ROWS: '25',
      READINGS_REALTIME_ROWS_PER_INSERT: '10',
      DB_POOL_SIZE: '20',
      DB_WAITING_HIGH_WATERMARK: '5',
      DB_SATURATION_HIGH_WATERMARK_PCT: '70',
      DB_BACKPRESSURE_SLEEP_MS: '500',
    },
    balanced: {
      REDIS_PIPELINE_FLUSH_INTERVAL_MS: '10',
      REDIS_INGESTION_STREAM_MAXLEN: '5000',
      REDIS_IDLE_INGESTION_STREAM_MAXLEN: '500',
      REDIS_DLQ_MAXLEN: '1000',
      REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT: '0.8',
      REDIS_MEMORY_HIGH_WATERMARK_PCT: '75',
      WORKER_COUNT: '6',
      BATCH_SIZE: '100',
      FLUSH_INTERVAL_MS: '500',
      AUTOSCALE_MIN_WORKERS: '4',
      AUTOSCALE_MAX_WORKERS: '16',
      AUTOSCALE_LAG_TARGET_MS: '5000',
      AUTOSCALE_LAG_SCALE_UP_MS: '2000',
      AUTOSCALE_LAG_CRITICAL_MS: '10000',
      AUTOSCALE_SCALE_DOWN_STABLE_CHECKS: '6',
      AUTOSCALE_COOLDOWN_MS: '3000',
      AUTOSCALE_DB_BLOCK_PCT: '80',
      READINGS_BULK_INSERT_MODE: 'copy',
      READINGS_COPY_MIN_ROWS: '1000',
      READINGS_REALTIME_MAX_ROWS: '50',
      READINGS_REALTIME_ROWS_PER_INSERT: '25',
      DB_POOL_SIZE: '24',
      DB_WAITING_HIGH_WATERMARK: '8',
      DB_SATURATION_HIGH_WATERMARK_PCT: '80',
      DB_BACKPRESSURE_SLEEP_MS: '250',
    },
    streaming: {
      REDIS_PIPELINE_FLUSH_INTERVAL_MS: '0',
      REDIS_INGESTION_STREAM_MAXLEN: '2000',
      REDIS_IDLE_INGESTION_STREAM_MAXLEN: '250',
      REDIS_DLQ_MAXLEN: '1000',
      REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT: '0.8',
      REDIS_MEMORY_HIGH_WATERMARK_PCT: '75',
      WORKER_COUNT: '8',
      BATCH_SIZE: '20',
      FLUSH_INTERVAL_MS: '100',
      AUTOSCALE_MIN_WORKERS: '6',
      AUTOSCALE_MAX_WORKERS: '20',
      AUTOSCALE_LAG_TARGET_MS: '2000',
      AUTOSCALE_LAG_SCALE_UP_MS: '1000',
      AUTOSCALE_LAG_CRITICAL_MS: '5000',
      AUTOSCALE_SCALE_DOWN_STABLE_CHECKS: '10',
      AUTOSCALE_COOLDOWN_MS: '2000',
      AUTOSCALE_DB_BLOCK_PCT: '80',
      READINGS_BULK_INSERT_MODE: 'realtime',
      READINGS_COPY_MIN_ROWS: '1000',
      READINGS_REALTIME_MAX_ROWS: '100',
      READINGS_REALTIME_ROWS_PER_INSERT: '10',
      DB_POOL_SIZE: '30',
      DB_WAITING_HIGH_WATERMARK: '10',
      DB_SATURATION_HIGH_WATERMARK_PCT: '85',
      DB_BACKPRESSURE_SLEEP_MS: '100',
    },
  }, 'test-catalog');

  const env: NodeJS.ProcessEnv = {
    INGESTION_PROFILE: 'streaming',
    BATCH_SIZE: '13',
    DB_POOL_SIZE: '',
  };

  const result = applyIngestionProfileForEnv(env, {
    catalog,
    catalogSource: 'test-catalog',
  });

  assert.equal(result.resolvedProfile, 'streaming');
  assert.equal(env.BATCH_SIZE, '13');
  assert.equal(env.DB_POOL_SIZE, '30');
  assert.ok(result.overriddenKeys.includes('BATCH_SIZE'));
  assert.ok(result.appliedDefaults.includes('DB_POOL_SIZE'));
  assert.equal(result.catalogSource, 'test-catalog');
});

test('applyIngestionProfileForEnv rejects invalid profile names', () => {
  assert.throws(() => applyIngestionProfileForEnv({ INGESTION_PROFILE: 'fast' }), /Unsupported ingestion profile/);
});