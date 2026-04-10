export interface VPNDevice {
    deviceId: string;
    customerId: string;
    vpnIP: string;
    commonName: string;
    connected: boolean;
    lastSeen: Date;
    certificateSerial: string;
    bytesReceived: number;
    bytesSent: number;
    connectedAt?: Date;
    disconnectedAt?: Date;
}
export interface VPNConnection {
    id: string;
    deviceId: string;
    customerId: string;
    vpnIP: string;
    realIP: string;
    connectedAt: Date;
    lastActivity: Date;
    bytesReceived: number;
    bytesSent: number;
    status: 'connected' | 'disconnected';
}
export interface CertificateInfo {
    serialNumber: string;
    commonName: string;
    deviceId: string;
    customerId: string;
    issuedAt: Date;
    expiresAt: Date;
    revoked: boolean;
    revokedAt?: Date;
}
export interface VPNServerConfig {
    host: string;
    port: number;
    protocol: 'udp' | 'tcp';
    subnet: string;
    netmask: string;
    maxClients: number;
    keepalivePing: number;
    keepaliveTimeout: number;
    enableCompression: boolean;
    enableClientToClient: boolean;
}
export interface PKIConfig {
    caKeyPath: string;
    caCertPath: string;
    serverKeyPath: string;
    serverCertPath: string;
    dhPath: string;
    taKeyPath: string;
    crlPath: string;
    certValidityDays: number;
    keySize: number;
}
export interface DatabaseConfig {
    url: string;
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    ssl?: boolean;
}
export interface RedisConfig {
    url: string;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
}
export interface APIConfig {
    port: number;
    host: string;
    corsOrigin: string;
    jwtSecret: string;
    enableDocs: boolean;
}
export interface LogConfig {
    level: 'debug' | 'info' | 'warn' | 'error';
    file?: string | undefined;
    maxSize?: string;
    maxFiles?: number;
}
export interface VPNServerOptions {
    vpn: VPNServerConfig;
    pki: PKIConfig;
    database: DatabaseConfig;
    redis: RedisConfig;
    api: APIConfig;
    logging: LogConfig;
}
export interface ClientConnectionEvent {
    type: 'connect' | 'disconnect';
    commonName: string;
    vpnIP: string;
    realIP: string;
    timestamp: Date;
    bytesReceived?: number;
    bytesSent?: number;
}
export interface VPNStats {
    totalDevices: number;
    connectedDevices: number;
    totalCustomers: number;
    activeCustomers: number;
    totalBytesTransferred: number;
    averageConnectionTime: number;
    certificatesExpiringSoon: number;
    revokedCertificates: number;
}
export interface DeviceCertificateRequest {
    deviceId: string;
    customerId: string;
    deviceName?: string;
    validityDays?: number;
}
export interface DeviceCertificateResponse {
    deviceId: string;
    customerId: string;
    commonName: string;
    certificate: string;
    privateKey: string;
    caCertificate: string;
    tlsAuthKey: string;
    clientConfig: string;
    serialNumber: string;
    expiresAt: Date;
}
export interface CertificateRevocationRequest {
    serialNumber?: string;
    deviceId?: string;
    reason?: string;
}
export interface VPNHealthStatus {
    status: 'healthy' | 'unhealthy' | 'degraded';
    vpnServer: {
        running: boolean;
        connectedClients: number;
        uptime: number;
    };
    database: {
        connected: boolean;
        responseTime: number;
    };
    redis: {
        connected: boolean;
        responseTime: number;
    };
    certificates: {
        caValid: boolean;
        serverValid: boolean;
        expiringSoon: number;
    };
    lastCheck: Date;
}
export interface OpenVPNStatus {
    title: string;
    time: Date;
    connectedClients: Array<{
        commonName: string;
        realAddress: string;
        virtualAddress: string;
        bytesReceived: number;
        bytesSent: number;
        connectedSince: Date;
    }>;
    routing: Array<{
        virtualAddress: string;
        commonName: string;
        realAddress: string;
        lastRef: Date;
    }>;
    globalStats: {
        maxBcastMcastQueueLen: number;
    };
}
export interface Logger {
    debug(message: string, meta?: any): void;
    info(message: string, meta?: any): void;
    warn(message: string, meta?: any): void;
    error(message: string, meta?: any): void;
}
//# sourceMappingURL=types.d.ts.map