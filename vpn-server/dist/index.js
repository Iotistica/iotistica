"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
const dotenv_1 = __importDefault(require("dotenv"));
const vpn_server_1 = require("./vpn-server");
const logger_1 = require("./logger");
dotenv_1.default.config();
function createServerConfig() {
    return {
        vpn: {
            host: process.env.VPN_SERVER_HOST || 'localhost',
            port: parseInt(process.env.VPN_SERVER_PORT || '1194', 10),
            protocol: process.env.VPN_PROTOCOL || 'udp',
            subnet: process.env.VPN_SUBNET || '10.8.0.0/16',
            netmask: process.env.VPN_NETMASK || '255.255.0.0',
            maxClients: parseInt(process.env.MAX_CLIENTS || '1000', 10),
            keepalivePing: parseInt(process.env.KEEPALIVE_PING || '10', 10),
            keepaliveTimeout: parseInt(process.env.KEEPALIVE_TIMEOUT || '120', 10),
            enableCompression: process.env.COMP_LZO === 'true',
            enableClientToClient: process.env.CLIENT_TO_CLIENT === 'true'
        },
        pki: {
            caKeyPath: process.env.VPN_CA_KEY_PATH || '/etc/openvpn/pki/private/ca.key',
            caCertPath: process.env.VPN_CA_CERT_PATH || '/etc/openvpn/pki/ca.crt',
            serverKeyPath: process.env.VPN_SERVER_KEY_PATH || '/etc/openvpn/pki/private/vpn-server.key',
            serverCertPath: process.env.VPN_SERVER_CERT_PATH || '/etc/openvpn/pki/issued/vpn-server.crt',
            dhPath: process.env.VPN_DH_PATH || '/etc/openvpn/pki/dh.pem',
            taKeyPath: process.env.VPN_TA_KEY_PATH || '/etc/openvpn/pki/ta.key',
            crlPath: process.env.VPN_CRL_PATH || '/etc/openvpn/pki/crl.pem',
            certValidityDays: parseInt(process.env.CERT_VALIDITY_DAYS || '365', 10),
            keySize: parseInt(process.env.CERT_KEY_SIZE || '2048', 10)
        },
        database: {
            url: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/iotistic_vpn',
            ssl: process.env.NODE_ENV === 'production'
        },
        redis: {
            url: process.env.REDIS_URL || 'redis://localhost:6379'
        },
        api: {
            port: parseInt(process.env.API_PORT || '3200', 10),
            host: process.env.API_HOST || '0.0.0.0',
            corsOrigin: process.env.API_CORS_ORIGIN || '*',
            jwtSecret: process.env.API_JWT_SECRET || 'your-super-secret-jwt-key',
            enableDocs: process.env.ENABLE_API_DOCS === 'true'
        },
        logging: {
            level: process.env.LOG_LEVEL || 'info',
            file: process.env.LOG_FILE,
            maxSize: process.env.LOG_MAX_SIZE || '10MB',
            maxFiles: parseInt(process.env.LOG_MAX_FILES || '5', 10)
        }
    };
}
function setupGracefulShutdown(server, logger) {
    const shutdown = async (signal) => {
        logger.info(`Received ${signal}, starting graceful shutdown...`);
        try {
            await server.stop();
            logger.info('VPN server stopped successfully');
            process.exit(0);
        }
        catch (error) {
            logger.error('Error during shutdown', { error });
            process.exit(1);
        }
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGHUP', () => shutdown('SIGHUP'));
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception detected', {
            message: error.message,
            name: error.name,
            stack: error.stack,
            code: error.code
        });
        const criticalErrors = ['EADDRINUSE', 'EACCES', 'ENOTFOUND'];
        if (criticalErrors.some(err => error.message?.includes(err))) {
            logger.error('Critical error detected, exiting...');
            process.exit(1);
        }
        else {
            logger.warn('Non-critical error, continuing operation');
        }
    });
    process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled promise rejection detected', {
            reason,
            reasonString: String(reason),
            promiseString: String(promise)
        });
    });
}
async function main() {
    const config = createServerConfig();
    const logger = (0, logger_1.createLogger)(config.logging);
    logger.info('Starting Iotistic VPN Server', {
        version: process.env.npm_package_version || '1.0.0',
        nodeVersion: process.version,
        platform: process.platform,
        environment: process.env.NODE_ENV || 'development'
    });
    try {
        const server = new vpn_server_1.VPNServer(config, logger);
        setupGracefulShutdown(server, logger);
        await server.initialize();
        await server.start();
        logger.info('VPN server started successfully', {
            vpnPort: config.vpn.port,
            apiPort: config.api.port,
            subnet: config.vpn.subnet,
            maxClients: config.vpn.maxClients
        });
        logger.info('Process will remain alive until receiving shutdown signal');
        setInterval(() => {
            logger.debug('VPN server health check', {
                uptime: process.uptime(),
                memory: process.memoryUsage()
            });
        }, 60000);
        await new Promise(() => {
        });
    }
    catch (error) {
        logger.error('Failed to start VPN server', { error });
        process.exit(1);
    }
}
if (require.main === module) {
    main().catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map