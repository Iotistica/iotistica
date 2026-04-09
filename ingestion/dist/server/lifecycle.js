"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startIngestionServer = startIngestionServer;
const logger_1 = __importDefault(require("../utils/logger"));
const shutdown_1 = require("./shutdown");
async function startIngestionServer(server) {
    const port = parseInt(process.env.PORT || '3003', 10);
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '0.0.0.0', () => {
                server.off('error', reject);
                resolve();
            });
        });
    }
    catch (error) {
        if (error instanceof Error) {
            const networkError = error;
            logger_1.default.error('Failed to bind ingestion HTTP server', {
                port,
                error: error.message,
                stack: error.stack,
                code: networkError.code,
                errno: networkError.errno,
                syscall: networkError.syscall,
                address: networkError.address,
            });
        }
        else {
            logger_1.default.error('Failed to bind ingestion HTTP server', { port, error: String(error) });
        }
        throw error;
    }
    logger_1.default.info('='.repeat(80));
    logger_1.default.info('Iotistica ingestion worker service');
    logger_1.default.info('='.repeat(80));
    logger_1.default.info(`Server running on http://localhost:${port}`);
    logger_1.default.info('='.repeat(80));
    const gracefulShutdown = (0, shutdown_1.createGracefulShutdown)({ server });
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('disconnect', () => gracefulShutdown('Debugger disconnect', 3000));
}
//# sourceMappingURL=lifecycle.js.map