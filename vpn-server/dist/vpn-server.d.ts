import { EventEmitter } from 'events';
import { VPNServerOptions, VPNConnection, Logger } from './types';
export interface VPNServerEvents {
    clientConnected: (client: VPNConnection) => void;
    clientDisconnected: (client: VPNConnection) => void;
    clientAuthenticated: (deviceId: string, clientInfo: any) => void;
    serverStarted: () => void;
    serverStopped: () => void;
    error: (error: Error) => void;
}
interface VPNServerStatus {
    running: boolean;
    startedAt: Date | undefined;
    connectedClients: number;
    totalConnections: number;
    lastError: string | undefined;
}
interface VPNServerMetrics {
    uptime: number;
    totalConnections: number;
    activeConnections: number;
    totalBytesTransferred: number;
    connectionsPerHour: number;
    averageSessionDuration: number;
    authenticatedDevices: number;
}
export declare class VPNServer extends EventEmitter {
    private config;
    private logger;
    private certificateManager;
    private process?;
    private status;
    private metrics;
    private connectedClients;
    private isShuttingDown;
    constructor(config: VPNServerOptions, logger: Logger);
    initialize(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    getStatus(): VPNServerStatus;
    getMetrics(): VPNServerMetrics;
    getConnectedClients(): VPNConnection[];
    provisionDevice(deviceId: string, customerId: string): Promise<any>;
    revokeDevice(deviceId: string): Promise<void>;
    private startOpenVPNProcess;
    private waitForServerStart;
    private parseOpenVPNOutput;
    private handleClientConnect;
    private handleClientDisconnect;
    private handleClientAuthentication;
    private disconnectClient;
    private generateServerConfig;
}
export {};
//# sourceMappingURL=vpn-server.d.ts.map