"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateProfileCatalog = validateProfileCatalog;
exports.applyIngestionProfileForEnv = applyIngestionProfileForEnv;
exports.applyIngestionProfile = applyIngestionProfile;
const profile_catalog_json_1 = __importDefault(require("./profile-catalog.json"));
const PROFILE_NAMES = ['batch', 'balanced', 'streaming'];
const PROFILE_ENV_KEYS = [
    'REDIS_PIPELINE_FLUSH_INTERVAL_MS',
    'REDIS_INGESTION_STREAM_MAXLEN',
    'REDIS_IDLE_INGESTION_STREAM_MAXLEN',
    'REDIS_DLQ_MAXLEN',
    'REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT',
    'REDIS_MEMORY_HIGH_WATERMARK_PCT',
    'WORKER_COUNT',
    'BATCH_SIZE',
    'FLUSH_INTERVAL_MS',
    'AUTOSCALE_MIN_WORKERS',
    'AUTOSCALE_MAX_WORKERS',
    'AUTOSCALE_LAG_TARGET_MS',
    'AUTOSCALE_LAG_SCALE_UP_MS',
    'AUTOSCALE_LAG_CRITICAL_MS',
    'AUTOSCALE_SCALE_DOWN_STABLE_CHECKS',
    'AUTOSCALE_COOLDOWN_MS',
    'AUTOSCALE_DB_BLOCK_PCT',
    'READINGS_BULK_INSERT_MODE',
    'READINGS_COPY_MIN_ROWS',
    'READINGS_REALTIME_MAX_ROWS',
    'READINGS_REALTIME_ROWS_PER_INSERT',
    'DB_POOL_SIZE',
    'DB_WAITING_HIGH_WATERMARK',
    'DB_SATURATION_HIGH_WATERMARK_PCT',
    'DB_BACKPRESSURE_SLEEP_MS',
];
const PROFILE_CATALOG_SOURCE = 'src/config/profile-catalog.json';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validateProfileCatalog(rawCatalog, source) {
    if (!isRecord(rawCatalog)) {
        throw new Error(`Invalid ingestion profile catalog in ${source}: expected an object at the top level`);
    }
    const catalog = {};
    for (const profileName of PROFILE_NAMES) {
        const rawProfile = rawCatalog[profileName];
        if (!isRecord(rawProfile)) {
            throw new Error(`Invalid ingestion profile catalog in ${source}: missing profile \"${profileName}\"`);
        }
        const defaults = {};
        for (const key of PROFILE_ENV_KEYS) {
            const value = rawProfile[key];
            if (typeof value !== 'string') {
                throw new Error(`Invalid ingestion profile catalog in ${source}: profile \"${profileName}\" key \"${key}\" must be a string`);
            }
            defaults[key] = value;
        }
        for (const key of Object.keys(rawProfile)) {
            if (!PROFILE_ENV_KEYS.includes(key)) {
                throw new Error(`Invalid ingestion profile catalog in ${source}: profile \"${profileName}\" contains unsupported key \"${key}\"`);
            }
        }
        catalog[profileName] = defaults;
    }
    for (const profileName of Object.keys(rawCatalog)) {
        if (!PROFILE_NAMES.includes(profileName)) {
            throw new Error(`Invalid ingestion profile catalog in ${source}: unsupported profile \"${profileName}\"`);
        }
    }
    return catalog;
}
const PROFILE_DEFAULTS = validateProfileCatalog(profile_catalog_json_1.default, PROFILE_CATALOG_SOURCE);
function resolveProfile(profile) {
    const normalized = (profile || 'balanced').trim().toLowerCase();
    switch (normalized) {
        case 'batch':
        case 'balanced':
        case 'streaming':
            return normalized;
        default:
            throw new Error(`Unsupported ingestion profile \"${profile}\". Expected one of: ${PROFILE_NAMES.join(', ')}`);
    }
}
function applyIngestionProfileForEnv(env, options) {
    const requestedProfile = options?.requestedProfile ?? env.INGESTION_PROFILE ?? 'balanced';
    const resolvedProfile = resolveProfile(requestedProfile);
    const defaults = (options?.catalog ?? PROFILE_DEFAULTS)[resolvedProfile];
    const appliedDefaults = [];
    const overriddenKeys = [];
    for (const key of PROFILE_ENV_KEYS) {
        if (env[key] === undefined || env[key] === '') {
            env[key] = defaults[key];
            appliedDefaults.push(key);
        }
        else {
            overriddenKeys.push(key);
        }
    }
    env.INGESTION_PROFILE = resolvedProfile;
    return {
        requestedProfile,
        resolvedProfile,
        appliedDefaults,
        overriddenKeys,
        catalogSource: options?.catalogSource ?? PROFILE_CATALOG_SOURCE,
    };
}
function applyIngestionProfile() {
    return applyIngestionProfileForEnv(process.env);
}
//# sourceMappingURL=profile.js.map