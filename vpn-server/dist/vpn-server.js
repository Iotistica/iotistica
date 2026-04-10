"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VPNServer = void 0;
const events_1 = require("events");
const child_process_1 = require("child_process");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const certificate_manager_1 = require("./certificate-manager");
class VPNServer extends events_1.EventEmitter {
    constructor(config, logger) {
        super();
        this.connectedClients = new Map();
        this.isShuttingDown = false;
        this.config = config;
        this.logger = logger;
        this.certificateManager = new certificate_manager_1.CertificateManager(config.pki, logger);
        this.status = {
            running: false,
            startedAt: undefined,
            connectedClients: 0,
            totalConnections: 0,
            lastError: undefined
        };
        this.metrics = {
            uptime: 0,
            totalConnections: 0,
            activeConnections: 0,
            totalBytesTransferred: 0,
            connectionsPerHour: 0,
            averageSessionDuration: 0,
            authenticatedDevices: 0
        };
    }
    async initialize() {
        this.logger.info('Initializing VPN server');
        try {
            await this.certificateManager.initialize();
            await this.generateServerConfig();
            this.logger.info('VPN server initialization complete');
        }
        catch (error) {
            this.logger.error('Failed to initialize VPN server', { error });
            throw error;
        }
    }
    async start() {
        if (this.status.running) {
            this.logger.warn('VPN server is already running');
            return;
        }
        this.logger.info('Starting VPN server');
        try {
            await this.startOpenVPNProcess();
            this.status.running = true;
            this.status.startedAt = new Date();
            this.status.lastError = undefined;
            this.emit('serverStarted');
            this.logger.info('VPN server started successfully');
        }
        catch (error) {
            this.status.lastError = error instanceof Error ? error.message : String(error);
            this.logger.error('Failed to start VPN server', { error });
            throw error;
        }
    }
    async stop() {
        if (!this.status.running) {
            this.logger.warn('VPN server is not running');
            return;
        }
        this.isShuttingDown = true;
        this.logger.info('Stopping VPN server');
        try {
            if (this.process) {
                this.process.kill('SIGTERM');
                await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        if (this.process) {
                            this.process.kill('SIGKILL');
                        }
                        resolve();
                    }, 10000);
                    if (this.process) {
                        this.process.on('exit', () => {
                            clearTimeout(timeout);
                            resolve();
                        });
                    }
                    else {
                        clearTimeout(timeout);
                        resolve();
                    }
                });
            }
            this.status.running = false;
            this.status.startedAt = undefined;
            this.connectedClients.clear();
            this.metrics.activeConnections = 0;
            this.emit('serverStopped');
            this.logger.info('VPN server stopped');
        }
        catch (error) {
            this.logger.error('Error stopping VPN server', { error });
            throw error;
        }
        finally {
            this.isShuttingDown = false;
        }
    }
    getStatus() {
        return { ...this.status };
    }
    getMetrics() {
        if (this.status.running && this.status.startedAt) {
            this.metrics.uptime = Math.floor((Date.now() - this.status.startedAt.getTime()) / 1000);
        }
        return { ...this.metrics };
    }
    getConnectedClients() {
        return Array.from(this.connectedClients.values());
    }
    async provisionDevice(deviceId, customerId) {
        this.logger.info('Provisioning device certificate', { deviceId, customerId });
        try {
            const certificate = await this.certificateManager.generateDeviceCertificate({
                deviceId,
                customerId
            });
            this.logger.info('Device certificate provisioned successfully', { deviceId });
            return certificate;
        }
        catch (error) {
            this.logger.error('Failed to provision device certificate', { deviceId, error });
            throw error;
        }
    }
    async revokeDevice(deviceId) {
        this.logger.info('Revoking device certificate', { deviceId });
        try {
            await this.certificateManager.revokeCertificate({
                deviceId
            });
            const client = this.connectedClients.get(deviceId);
            if (client) {
                this.disconnectClient(deviceId);
            }
            this.logger.info('Device certificate revoked successfully', { deviceId });
        }
        catch (error) {
            this.logger.error('Failed to revoke device certificate', { deviceId, error });
            throw error;
        }
    }
    async startOpenVPNProcess() {
        try {
            const { execSync } = require('child_process');
            execSync('pgrep openvpn', { stdio: 'pipe' });
            this.logger.info('OpenVPN already running, skipping process start');
            return;
        }
        catch (error) {
            this.logger.info('Starting OpenVPN process');
        }
        const configPath = path.join(process.cwd(), 'config', 'server.conf');
        this.process = (0, child_process_1.spawn)('openvpn', [configPath], {
            stdio: 'pipe',
            env: process.env
        });
        this.process.on('error', (error) => {
            this.logger.error('OpenVPN process error', { error });
            this.emit('error', error);
        });
        this.process.on('exit', (code, signal) => {
            this.logger.info('OpenVPN process exited', { code, signal });
            if (!this.isShuttingDown) {
                this.status.running = false;
                this.emit('error', new Error(`OpenVPN process exited unexpectedly: ${code}`));
            }
        });
        if (this.process.stdout) {
            this.process.stdout.on('data', (data) => {
                const output = data.toString();
                this.parseOpenVPNOutput(output);
            });
        }
        if (this.process.stderr) {
            this.process.stderr.on('data', (data) => {
                const error = data.toString();
                this.logger.error('OpenVPN stderr', { error });
            });
        }
        await this.waitForServerStart();
    }
    async waitForServerStart() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('OpenVPN server start timeout'));
            }, 30000);
            const checkStart = () => {
                setTimeout(() => {
                    clearTimeout(timeout);
                    resolve();
                }, 2000);
            };
            checkStart();
        });
    }
    parseOpenVPNOutput(output) {
        const lines = output.split('\n');
        for (const line of lines) {
            if (line.includes('CLIENT_CONNECT')) {
                this.handleClientConnect(line);
            }
            else if (line.includes('CLIENT_DISCONNECT')) {
                this.handleClientDisconnect(line);
            }
            else if (line.includes('TLS: Username/Password authentication')) {
                this.handleClientAuthentication(line);
            }
        }
    }
    handleClientConnect(logLine) {
        try {
            const parts = logLine.split(',');
            if (parts.length >= 4) {
                const deviceId = parts[1];
                const realIP = parts[2];
                const vpnIP = parts[3];
                const client = {
                    id: `${deviceId}-${Date.now()}`,
                    deviceId,
                    customerId: '',
                    realIP,
                    vpnIP,
                    connectedAt: new Date(),
                    lastActivity: new Date(),
                    bytesReceived: 0,
                    bytesSent: 0,
                    status: 'connected'
                };
                this.connectedClients.set(deviceId, client);
                this.metrics.activeConnections = this.connectedClients.size;
                this.metrics.totalConnections++;
                this.status.connectedClients = this.connectedClients.size;
                this.emit('clientConnected', client);
                this.logger.info('Client connected', { deviceId, realIP, vpnIP });
            }
        }
        catch (error) {
            this.logger.error('Error parsing client connect event', { error, logLine });
        }
    }
    handleClientDisconnect(logLine) {
        try {
            const parts = logLine.split(',');
            if (parts.length >= 2) {
                const deviceId = parts[1];
                const client = this.connectedClients.get(deviceId);
                if (client) {
                    this.connectedClients.delete(deviceId);
                    this.metrics.activeConnections = this.connectedClients.size;
                    this.status.connectedClients = this.connectedClients.size;
                    this.emit('clientDisconnected', client);
                    this.logger.info('Client disconnected', { deviceId });
                }
            }
        }
        catch (error) {
            this.logger.error('Error parsing client disconnect event', { error, logLine });
        }
    }
    handleClientAuthentication(logLine) {
        try {
            const deviceIdMatch = logLine.match(/device[_-]([a-zA-Z0-9-]+)/);
            if (deviceIdMatch) {
                const deviceId = deviceIdMatch[1];
                this.metrics.authenticatedDevices++;
                this.emit('clientAuthenticated', deviceId, { logLine });
                this.logger.info('Client authenticated', { deviceId });
            }
        }
        catch (error) {
            this.logger.error('Error parsing client authentication event', { error, logLine });
        }
    }
    disconnectClient(deviceId) {
        const client = this.connectedClients.get(deviceId);
        if (client) {
            this.logger.info('Disconnecting client', { deviceId });
            this.connectedClients.delete(deviceId);
            this.metrics.activeConnections = this.connectedClients.size;
            this.status.connectedClients = this.connectedClients.size;
            this.emit('clientDisconnected', client);
        }
    }
    async generateServerConfig() {
        const openvpnConfigPath = '/etc/openvpn/server.conf';
        try {
            await fs.access(openvpnConfigPath);
            this.logger.info('Using existing OpenVPN configuration', { configPath: openvpnConfigPath });
            return;
        }
        catch (error) {
            this.logger.info('Generating OpenVPN configuration from template');
        }
        const configPath = path.join(process.cwd(), 'config', 'server.conf');
        const templatePath = path.join(__dirname, '../config/server.conf');
        let config = await fs.readFile(templatePath, 'utf8');
        config = config.replace(/{{PORT}}/g, this.config.vpn.port.toString());
        config = config.replace(/{{PROTOCOL}}/g, this.config.vpn.protocol);
        config = config.replace(/{{CONFIG_DIR}}/g, process.cwd() + '/config');
        config = config.replace(/{{PKI_DIR}}/g, this.config.pki.caCertPath.replace('/ca.crt', ''));
        config = config.replace(/{{LOG_LEVEL}}/g, this.config.logging.level);
        await fs.writeFile(configPath, config, 'utf8');
        this.logger.info('Generated OpenVPN server configuration', { configPath });
    }
}
exports.VPNServer = VPNServer;
//# sourceMappingURL=vpn-server.js.map