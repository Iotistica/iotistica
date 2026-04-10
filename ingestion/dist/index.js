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
const profile_1 = require("./config/profile");
async function main() {
    const profileConfig = (0, profile_1.applyIngestionProfile)();
    const [{ default: logger }, { createIngestionServer }, { startIngestionServer }, { bootstrapConfig }, { bootstrapDatabaseConnection }, { bootstrapIngestionRedis },] = await Promise.all([
        Promise.resolve().then(() => __importStar(require('./utils/logger'))),
        Promise.resolve().then(() => __importStar(require('./server/app'))),
        Promise.resolve().then(() => __importStar(require('./server/lifecycle'))),
        Promise.resolve().then(() => __importStar(require('./bootstrap/config'))),
        Promise.resolve().then(() => __importStar(require('./bootstrap/database'))),
        Promise.resolve().then(() => __importStar(require('./bootstrap/redis'))),
    ]);
    logger.info('Initializing Iotistica ingestion service...');
    logger.info('Resolved ingestion runtime profile', {
        requestedProfile: profileConfig.requestedProfile,
        resolvedProfile: profileConfig.resolvedProfile,
        appliedDefaults: profileConfig.appliedDefaults,
    });
    await bootstrapDatabaseConnection();
    await bootstrapConfig();
    const server = createIngestionServer();
    await bootstrapIngestionRedis();
    await startIngestionServer(server);
}
main().catch((error) => {
    void Promise.resolve().then(() => __importStar(require('./utils/logger'))).then(({ default: logger }) => {
        if (error instanceof Error) {
            const networkError = error;
            logger.error('Failed to start ingestion service', {
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
            logger.error('Failed to start ingestion service', { error: String(error) });
        }
        process.exit(1);
    }).catch(() => {
        console.error('Failed to start ingestion service', error);
        process.exit(1);
    });
});
//# sourceMappingURL=index.js.map