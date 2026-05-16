export declare const CONFIG_DIR: string;
export declare const DB_PATH: string;
export declare const DEVICE_API_BASE: string;
export declare const DEVICE_API_V1: string;
export declare const ENV: {
    isContainer: boolean;
    hasDocker: boolean;
};
export declare class CLIError extends Error {
    exitCode: number;
    context?: Record<string, any> | undefined;
    constructor(message: string, exitCode?: number, context?: Record<string, any> | undefined);
}
export declare class CLILogger {
    info(message: string, context?: Record<string, any>): void;
    error(message: string, error?: Error, context?: Record<string, any>): void;
    warn(message: string, context?: Record<string, any>): void;
    debug(message: string, context?: Record<string, any>): void;
}
export declare const logger: CLILogger;
export declare function apiCached(endpoint: string): Promise<any>;
export declare function clearApiCache(): void;
export declare function apiRequest(endpoint: string, options?: RequestInit): Promise<any>;
export declare function apiProbe(endpoint: string, options?: RequestInit): Promise<{
    ok: boolean;
    status?: number;
    data?: any;
    error?: string;
}>;
export declare function getFlagValue(flag: string): string | undefined;
export declare function normalizePositionalArg(arg?: string): string | undefined;
export declare function validateUrl(url: string): boolean;
export declare function requireConfirmation(message: string): void;
export declare function redact(value: string | undefined | null): string;
export declare function sleep(ms: number): Promise<void>;
export declare function getDbSizeMb(): string | null;
//# sourceMappingURL=core.d.ts.map