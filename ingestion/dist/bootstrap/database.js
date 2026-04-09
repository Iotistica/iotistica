"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapDatabaseConnection = bootstrapDatabaseConnection;
const logger_1 = __importDefault(require("../utils/logger"));
const connection_1 = require("../db/connection");
async function waitForDatabase(maxAttempts = 10) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (await (0, connection_1.testConnection)()) {
            return;
        }
        if (attempt === maxAttempts) {
            break;
        }
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        logger_1.default.warn('PostgreSQL not ready, retrying...', { attempt, maxAttempts, retryInMs: delayMs });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`PostgreSQL did not become ready after ${maxAttempts} attempts`);
}
async function bootstrapDatabaseConnection() {
    logger_1.default.info('Attempting PostgreSQL connection:', {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || '5432',
        database: process.env.DB_NAME || 'iotistic',
        user: process.env.DB_USER || 'postgres',
    });
    await waitForDatabase();
    logger_1.default.info('Database connection verified');
}
//# sourceMappingURL=database.js.map