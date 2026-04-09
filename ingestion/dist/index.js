"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./server/app");
const lifecycle_1 = require("./server/lifecycle");
const logger_1 = __importDefault(require("./utils/logger"));
const config_1 = require("./bootstrap/config");
const database_1 = require("./bootstrap/database");
const redis_1 = require("./bootstrap/redis");
async function main() {
    logger_1.default.info('Initializing Iotistica ingestion service...');
    await (0, database_1.bootstrapDatabaseConnection)();
    await (0, config_1.bootstrapConfig)();
    const server = (0, app_1.createIngestionServer)();
    await (0, redis_1.bootstrapIngestionRedis)();
    await (0, lifecycle_1.startIngestionServer)(server);
}
main().catch((error) => {
    if (error instanceof Error) {
        const networkError = error;
        logger_1.default.error('Failed to start ingestion service', {
            error: error.message,
            stack: error.stack,
            code: networkError.code,
            errno: networkError.errno,
            syscall: networkError.syscall,
            address: networkError.address,
            port: networkError.port,
        });
    }
    else {
        logger_1.default.error('Failed to start ingestion service', { error: String(error) });
    }
    process.exit(1);
});
//# sourceMappingURL=index.js.map