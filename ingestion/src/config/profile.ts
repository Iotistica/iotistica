export type IngestionProfile = 'batch' | 'balanced' | 'streaming';

interface AppliedProfileConfig {
  requestedProfile: string;
  resolvedProfile: IngestionProfile;
  appliedDefaults: string[];
}

const PROFILE_DEFAULTS: Record<IngestionProfile, Record<string, string>> = {
  batch: {
    REDIS_PIPELINE_FLUSH_INTERVAL_MS: '50',
    REDIS_INGESTION_STREAM_MAXLEN: '10000',
    REDIS_IDLE_INGESTION_STREAM_MAXLEN: '1000',
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
    READINGS_BULK_INSERT_MODE: 'copy',
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
    READINGS_BULK_INSERT_MODE: 'copy',
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
    READINGS_BULK_INSERT_MODE: 'realtime',
    READINGS_REALTIME_MAX_ROWS: '100',
    READINGS_REALTIME_ROWS_PER_INSERT: '10',
    DB_POOL_SIZE: '30',
    DB_WAITING_HIGH_WATERMARK: '10',
    DB_SATURATION_HIGH_WATERMARK_PCT: '85',
    DB_BACKPRESSURE_SLEEP_MS: '100',
  },
};

function resolveProfile(profile: string | undefined): IngestionProfile {
  const normalized = (profile || 'balanced').trim().toLowerCase();
  switch (normalized) {
    case 'batch':
    case 'balanced':
    case 'streaming':
      return normalized;
    default:
      return 'balanced';
  }
}

export function applyIngestionProfile(): AppliedProfileConfig {
  const requestedProfile = process.env.INGESTION_PROFILE || 'balanced';
  const resolvedProfile = resolveProfile(requestedProfile);
  const defaults = PROFILE_DEFAULTS[resolvedProfile];
  const appliedDefaults: string[] = [];

  for (const [key, value] of Object.entries(defaults)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      appliedDefaults.push(key);
    }
  }

  process.env.INGESTION_PROFILE = resolvedProfile;
  return {
    requestedProfile,
    resolvedProfile,
    appliedDefaults,
  };
}
