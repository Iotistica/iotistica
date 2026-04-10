export type IngestionProfile = 'batch' | 'balanced' | 'streaming';
declare const PROFILE_ENV_KEYS: readonly ["REDIS_PIPELINE_FLUSH_INTERVAL_MS", "REDIS_INGESTION_STREAM_MAXLEN", "REDIS_IDLE_INGESTION_STREAM_MAXLEN", "REDIS_DLQ_MAXLEN", "REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT", "REDIS_MEMORY_HIGH_WATERMARK_PCT", "WORKER_COUNT", "BATCH_SIZE", "FLUSH_INTERVAL_MS", "AUTOSCALE_MIN_WORKERS", "AUTOSCALE_MAX_WORKERS", "AUTOSCALE_LAG_TARGET_MS", "AUTOSCALE_LAG_SCALE_UP_MS", "AUTOSCALE_LAG_CRITICAL_MS", "AUTOSCALE_SCALE_DOWN_STABLE_CHECKS", "AUTOSCALE_COOLDOWN_MS", "AUTOSCALE_DB_BLOCK_PCT", "READINGS_BULK_INSERT_MODE", "READINGS_COPY_MIN_ROWS", "READINGS_REALTIME_MAX_ROWS", "READINGS_REALTIME_ROWS_PER_INSERT", "DB_POOL_SIZE", "DB_WAITING_HIGH_WATERMARK", "DB_SATURATION_HIGH_WATERMARK_PCT", "DB_BACKPRESSURE_SLEEP_MS"];
type ProfileEnvKey = typeof PROFILE_ENV_KEYS[number];
type ProfileDefaults = Record<ProfileEnvKey, string>;
type ProfileCatalog = Record<IngestionProfile, ProfileDefaults>;
interface AppliedProfileConfig {
    requestedProfile: string;
    resolvedProfile: IngestionProfile;
    appliedDefaults: string[];
    overriddenKeys: string[];
    catalogSource: string;
}
export declare function validateProfileCatalog(rawCatalog: unknown, source: string): ProfileCatalog;
export declare function applyIngestionProfileForEnv(env: NodeJS.ProcessEnv, options?: {
    requestedProfile?: string;
    catalog?: ProfileCatalog;
    catalogSource?: string;
}): AppliedProfileConfig;
export declare function applyIngestionProfile(): AppliedProfileConfig;
export {};
//# sourceMappingURL=profile.d.ts.map