export interface ReadingInsert {
    agent_uuid: string;
    metric_name: string;
    value: number | null;
    quality?: string;
    unit?: string;
    protocol: string;
    extra?: ReadingExtra;
    extraJson?: string;
    detectionMethodsJson?: string;
    time?: Date;
    anomaly_score?: number;
    anomaly_threshold?: number;
    baseline_samples?: number;
    detection_methods?: any;
}
export interface ReadingExtra {
    endpoint_uuid?: string;
    device_uuid?: string;
    device_name?: string;
    ingested_at?: string;
    [key: string]: any;
}
export declare class ReadingsService {
    private static refreshInFlight;
    private static lastRefreshAttemptAtMs;
    private static readonly LOCAL_REFRESH_ATTEMPT_COOLDOWN_MS;
    private static readonly CATALOG_DISCOVERY_CACHE_MAX;
    private static readonly seenCatalogDevices;
    private static readonly seenCatalogMetrics;
    private static readonly seenCatalogDeviceMetrics;
    private static readonly COPY_TEMP_TABLE_NAME;
    private static readonly COPY_TEMP_TABLE_READY_FLAG;
    private static readonly REDIS_CATALOG_LEASE_KEY;
    private static getRedis;
    private readonly MAX_ROWS_PER_BULK_INSERT;
    private readonly COPY_STAGE_ROWS_PER_BATCH;
    private readonly BULK_INSERT_MODE;
    private readonly COPY_MIN_ROWS;
    private escapeCopyText;
    private copyValue;
    private toCopyLine;
    private ensureCopyTempTable;
    private bulkInsertViaCopy;
    private noteCatalogCandidates;
    private refreshMetricCatalog;
    insert(reading: ReadingInsert): Promise<void>;
    bulkInsert(readings: ReadingInsert[]): Promise<number>;
}
export declare const readingsService: ReadingsService;
//# sourceMappingURL=readings.service.d.ts.map