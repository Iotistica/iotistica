export declare function normalizeTenantId(tenantId: string): string;
export declare function tenantPrefix(tenantId: string): string;
export declare function agentStateChannel(tenantId: string, deviceUuid: string): string;
export declare function agentMetricsChannel(tenantId: string, deviceUuid: string): string;
export declare function agentMetricsPattern(tenantId: string): string;
export declare function metricsStreamKey(tenantId: string, deviceUuid: string): string;
export declare function metricsStreamScanPattern(tenantId: string): string;
export declare function parseMetricsStreamKey(streamKey: string): {
    tenantId: string;
    uuid: string;
};
export declare function uuidFromMetricsStreamKey(streamKey: string): string;
export declare function parseMetricsChannel(channel: string): {
    tenantId: string;
    uuid: string;
};
export declare function uuidFromMetricsChannel(channel: string): string;
export declare function deviceLogsStreamKey(tenantId: string): string;
export declare function agentDevicesIngestionStreamKey(tenantId: string): string;
export declare function parseAgentDevicesIngestionStreamKey(streamKey: string): {
    tenantId: string;
};
export declare function agentDevicesReadyStreamKey(tenantId: string): string;
export declare function agentDevicesDlqStreamKey(tenantId: string): string;
export declare function consumerGroupName(tenantId: string, groupName: string): string;
export declare function consumerName(tenantId: string, workerName: string): string;
//# sourceMappingURL=tenant-keys.d.ts.map