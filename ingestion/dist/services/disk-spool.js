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
exports.DiskSpool = void 0;
const fs = __importStar(require("fs/promises"));
const fsSync = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../utils/logger");
const circuit_breaker_1 = require("./circuit-breaker");
class DiskSpool {
    spoolPath;
    maxSizeMb;
    currentFile = null;
    currentSize = 0;
    fileIndex = 0;
    replayInterval = null;
    enabled = false;
    constructor(spoolPath, maxSizeMb) {
        this.spoolPath = spoolPath;
        this.maxSizeMb = maxSizeMb;
    }
    async initialize() {
        try {
            if (!fsSync.existsSync(this.spoolPath)) {
                await fs.mkdir(this.spoolPath, { recursive: true });
                logger_1.logger.debug('Created disk spool directory', { path: this.spoolPath });
            }
            const testFile = path.join(this.spoolPath, '.write-test');
            await fs.writeFile(testFile, '');
            await fs.unlink(testFile);
            this.enabled = true;
            logger_1.logger.debug('Disk spool fallback initialized', {
                path: this.spoolPath,
                maxSizeMb: this.maxSizeMb,
            });
        }
        catch (err) {
            logger_1.logger.error('Failed to initialize disk spool — spool disabled, circuit-breaker fallback will drop data.' +
                ' Ensure the spool directory is writable by the container user.' +
                ' If using a Docker named volume, recreate it after rebuilding the image.', { path: this.spoolPath, error: err.message });
            this.enabled = false;
        }
    }
    isEnabled() {
        return this.enabled;
    }
    async spoolToDisk(deviceData) {
        const payload = JSON.stringify(deviceData);
        const payloadSize = Buffer.byteLength(payload, 'utf8');
        const totalSpoolSize = await this.getTotalSize();
        if (totalSpoolSize + payloadSize > this.maxSizeMb * 1024 * 1024) {
            await this.deleteOldestFile();
        }
        if (!this.currentFile || this.currentSize > 10 * 1024 * 1024) {
            this.fileIndex++;
            this.currentFile = path.join(this.spoolPath, `spool-${this.fileIndex}.ndjson`);
            this.currentSize = 0;
        }
        await fs.appendFile(this.currentFile, payload + '\n');
        this.currentSize += payloadSize;
        logger_1.logger.debug('Spooled device data to disk', {
            count: deviceData.length,
            file: path.basename(this.currentFile),
            sizeBytes: payloadSize,
            totalSpoolMb: Math.round(totalSpoolSize / 1024 / 1024),
        });
    }
    startReplayer(onBatch, isReady) {
        this.replayInterval = setInterval(async () => {
            if (circuit_breaker_1.circuitBreaker.getState() !== circuit_breaker_1.CircuitState.CLOSED)
                return;
            if (isReady && !isReady())
                return;
            try {
                const files = (await fs.readdir(this.spoolPath))
                    .filter(f => f.startsWith('spool-'))
                    .sort();
                if (files.length === 0)
                    return;
                const oldestFile = path.join(this.spoolPath, files[0]);
                const content = await fs.readFile(oldestFile, 'utf8');
                const lines = content.split('\n').filter(l => l.trim());
                logger_1.logger.debug('Replaying spooled data to Redis', {
                    file: files[0],
                    batches: lines.length,
                    totalSpooledFiles: files.length,
                });
                await fs.unlink(oldestFile);
                if (this.currentFile === oldestFile) {
                    this.currentFile = null;
                }
                for (const line of lines) {
                    try {
                        const deviceData = JSON.parse(line);
                        await onBatch(deviceData);
                    }
                    catch (err) {
                        logger_1.logger.error('Failed to replay spooled batch', { error: err.message });
                    }
                }
                logger_1.logger.debug('Replayed and deleted spool file', { file: files[0] });
            }
            catch (err) {
                logger_1.logger.error('Spool replay error', { error: err.message });
            }
        }, 10000);
    }
    async getTotalSize() {
        try {
            const files = await fs.readdir(this.spoolPath);
            const sizes = await Promise.all(files.map(file => fs.stat(path.join(this.spoolPath, file)).then(s => s.size).catch(() => 0)));
            return sizes.reduce((total, size) => total + size, 0);
        }
        catch {
            return 0;
        }
    }
    async getBacklogCount() {
        if (!this.enabled)
            return 0;
        try {
            const files = await fs.readdir(this.spoolPath);
            return files.filter(f => f.startsWith('spool-')).length;
        }
        catch {
            return 0;
        }
    }
    async deleteOldestFile() {
        try {
            const files = (await fs.readdir(this.spoolPath))
                .filter(f => f.startsWith('spool-'))
                .sort();
            if (files.length > 0) {
                const oldestFile = path.join(this.spoolPath, files[0]);
                await fs.unlink(oldestFile);
                logger_1.logger.warn('Deleted oldest spool file (disk full)', { file: files[0] });
            }
        }
        catch (err) {
            logger_1.logger.error('Failed to delete oldest spool file', { error: err.message });
        }
    }
}
exports.DiskSpool = DiskSpool;
//# sourceMappingURL=disk-spool.js.map