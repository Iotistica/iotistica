import pino from 'pino';
export interface AppLogger {
    info(message: string): void;
    info(message: string, meta: unknown): void;
    info(meta: unknown, message?: string): void;
    warn(message: string): void;
    warn(message: string, meta: unknown): void;
    warn(meta: unknown, message?: string): void;
    error(message: string): void;
    error(message: string, meta: unknown): void;
    error(meta: unknown, message?: string): void;
    debug(message: string): void;
    debug(message: string, meta: unknown): void;
    debug(meta: unknown, message?: string): void;
    child(bindings: Record<string, unknown>): AppLogger;
}
export declare function createAppLogger(bindings?: Record<string, unknown>): AppLogger;
declare const pinoLogger: pino.Logger<never, boolean>;
declare const logger: AppLogger;
export default logger;
export { logger, pinoLogger };
//# sourceMappingURL=logger.d.ts.map