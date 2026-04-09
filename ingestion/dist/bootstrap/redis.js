"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapIngestionRedis = bootstrapIngestionRedis;
const logger_1 = __importDefault(require("../utils/logger"));
const client_factory_1 = require("../redis/client-factory");
const services_1 = require("../services");
async function connectSharedRedisClient() {
    const client = (0, client_factory_1.getRedisClient)();
    if (client.status === 'ready') {
        logger_1.default.info('Redis already connected');
        return;
    }
    await new Promise((resolve, reject) => {
        const onReady = () => {
            client.off('error', onError);
            resolve();
        };
        const onError = (err) => {
            client.off('ready', onReady);
            reject(err);
        };
        client.once('ready', onReady);
        client.once('error', onError);
    });
}
async function bootstrapIngestionRedis() {
    try {
        await connectSharedRedisClient();
        logger_1.default.info('[OK] Redis client connected successfully');
    }
    catch (error) {
        logger_1.default.warn('Redis connection failed - continuing without real-time features', {
            error: error instanceof Error ? error.message : String(error),
            note: 'This is non-critical - metrics will use PostgreSQL only',
        });
    }
    try {
        await services_1.redisDeviceQueue.startWorker();
        logger_1.default.info('Redis device queue worker started');
    }
    catch (error) {
        logger_1.default.error('Failed to start Redis device queue worker', { error });
        process.exit(1);
    }
}
//# sourceMappingURL=redis.js.map