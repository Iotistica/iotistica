import type { Server } from 'http';
export interface ShutdownContext {
    server: Server;
}
export declare function createGracefulShutdown(ctx: ShutdownContext): (reason: string, timeoutMs?: number) => Promise<void>;
//# sourceMappingURL=shutdown.d.ts.map