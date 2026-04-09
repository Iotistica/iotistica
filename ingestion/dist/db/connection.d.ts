import { Pool, type PoolClient, type QueryResult } from 'pg';
export declare const pool: Pool;
export interface DbPoolStats {
    total: number;
    idle: number;
    active: number;
    waiting: number;
    saturationPct: number;
    configuredMax: number;
}
export declare function getPoolStats(): DbPoolStats;
export declare function query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
export declare function getClient(): Promise<PoolClient>;
export declare function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
export declare function testConnection(): Promise<boolean>;
export declare function close(): Promise<void>;
//# sourceMappingURL=connection.d.ts.map