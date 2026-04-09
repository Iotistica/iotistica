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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGracefulShutdown = createGracefulShutdown;
const logger_1 = __importDefault(require("../utils/logger"));
const connection_1 = require("../db/connection");
const client_factory_1 = require("../redis/client-factory");
function createGracefulShutdown(ctx) {
    return async function gracefulShutdown(reason, timeoutMs = 10000) {
        logger_1.default.info(`${reason} received, shutting down gracefully...`);
        const forceClose = setTimeout(() => {
            logger_1.default.warn('Forcefully closing ingestion server after timeout');
            process.exit(1);
        }, timeoutMs);
        try {
            const { redisDeviceQueue } = await Promise.resolve().then(() => __importStar(require('../services')));
            await redisDeviceQueue.stopWorker();
            logger_1.default.info('Redis device queue worker stopped');
        }
        catch (error) {
            logger_1.default.error('Error stopping Redis device queue worker', { error });
        }
        try {
            await (0, connection_1.close)();
            logger_1.default.info('Database connection closed');
        }
        catch (error) {
            logger_1.default.error('Error closing database connection', { error });
        }
        try {
            await (0, client_factory_1.closeAllRedisClients)();
            logger_1.default.info('Redis clients closed');
        }
        catch (error) {
            logger_1.default.error('Error closing Redis clients', { error });
        }
        await new Promise((resolve, reject) => {
            ctx.server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        logger_1.default.info('HTTP server closed');
        clearTimeout(forceClose);
        process.exit(0);
    };
}
//# sourceMappingURL=shutdown.js.map