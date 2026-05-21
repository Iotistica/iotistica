"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbBackup = dbBackup;
exports.dbList = dbList;
exports.dbStats = dbStats;
exports.dbVerify = dbVerify;
exports.dbRestore = dbRestore;
exports.dbPrune = dbPrune;
const fs_1 = require("fs");
const path_1 = require("path");
const core_1 = require("../core");
let dbBackupServiceCache = null;
async function loadDbBackupService() {
    if (dbBackupServiceCache) {
        return dbBackupServiceCache;
    }
    const candidates = [
        (0, path_1.join)(__dirname, '..', '..', '..', 'agent', 'dist', 'db', 'backup.js'),
        (0, path_1.join)(process.cwd(), 'agent', 'dist', 'db', 'backup.js'),
        (0, path_1.join)(process.cwd(), 'dist', 'db', 'backup.js'),
    ];
    for (const candidatePath of candidates) {
        if (!(0, fs_1.existsSync)(candidatePath)) {
            continue;
        }
        let loaded;
        try {
            loaded = require(candidatePath);
        }
        catch {
            continue;
        }
        const service = loaded;
        if (typeof service.createDbBackup === 'function' &&
            typeof service.listDbBackups === 'function' &&
            typeof service.verifyDbBackup === 'function' &&
            typeof service.restoreDbFromBackup === 'function' &&
            typeof service.pruneDbBackups === 'function') {
            dbBackupServiceCache = service;
            return service;
        }
    }
    throw new core_1.CLIError('DB backup service module not found', 1, {
        hint: 'Run npm run build in the agent package so dist/db/backup.js is available',
    });
}
function getFallbackBackupDir() {
    return (0, path_1.join)((0, path_1.dirname)(core_1.DB_PATH), 'backups', 'db');
}
function getMetadataPathForBackup(backupPath) {
    return `${backupPath}.meta.json`;
}
function readFallbackBackupMetadata(backupPath) {
    const metadataPath = getMetadataPathForBackup(backupPath);
    if (!(0, fs_1.existsSync)(metadataPath)) {
        return undefined;
    }
    try {
        const parsed = JSON.parse((0, fs_1.readFileSync)(metadataPath, 'utf-8'));
        return parsed;
    }
    catch {
        return undefined;
    }
}
function listDbBackupsFallback(backupDir) {
    if (!(0, fs_1.existsSync)(backupDir)) {
        return [];
    }
    return (0, fs_1.readdirSync)(backupDir)
        .filter((name) => name.endsWith('.sqlite'))
        .map((fileName) => {
        const backupPath = (0, path_1.join)(backupDir, fileName);
        const stat = (0, fs_1.statSync)(backupPath);
        const metadata = readFallbackBackupMetadata(backupPath);
        return {
            backupPath,
            metadataPath: getMetadataPathForBackup(backupPath),
            fileName,
            sizeBytes: stat.size,
            createdAt: metadata?.createdAt || stat.mtime.toISOString(),
            checksumSha256: metadata?.checksumSha256,
        };
    })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function resolveBackupPathFromTarget(backups, target) {
    if (backups.length === 0) {
        throw new core_1.CLIError('No backups found', 1, {
            hint: 'Run iotctl db backup first',
        });
    }
    if (!target || target === 'latest') {
        return backups[0].backupPath;
    }
    if ((0, fs_1.existsSync)(target)) {
        return target;
    }
    const byName = backups.find((item) => item.fileName === target);
    if (byName) {
        return byName.backupPath;
    }
    throw new core_1.CLIError('Backup target not found', 1, {
        target,
        hint: 'Use iotctl db backups list to see available backups',
    });
}
/**
 * iotctl db backup [<name>]
 */
async function dbBackup(nameArg) {
    const service = await loadDbBackupService();
    const backupDir = service.getDefaultBackupDir(core_1.DB_PATH);
    const name = (0, core_1.normalizePositionalArg)(nameArg) || (0, core_1.getFlagValue)('--name');
    const result = await service.createDbBackup({
        dbPath: core_1.DB_PATH,
        backupDir,
        name,
    });
    core_1.logger.info('Database backup created', {
        file: result.fileName,
        path: result.backupPath,
        sizeBytes: result.sizeBytes,
        checksumSha256: result.checksumSha256,
    });
}
/**
 * iotctl db backups list
 */
async function dbList() {
    const backupDir = getFallbackBackupDir();
    let backups = [];
    try {
        const service = await loadDbBackupService();
        backups = service.listDbBackups({ backupDir });
    }
    catch {
        backups = listDbBackupsFallback(backupDir);
    }
    if (backups.length === 0) {
        core_1.logger.info('No saved database backups found', { backupDir });
        return;
    }
    core_1.logger.info('Saved database backups', {
        backupDir,
        count: backups.length,
    });
    for (const backup of backups) {
        core_1.logger.info(backup.fileName, {
            createdAt: backup.createdAt,
            sizeBytes: backup.sizeBytes,
            checksumSha256: backup.checksumSha256 || 'metadata-missing',
        });
    }
}
/**
 * iotctl db stats
 */
async function dbStats() {
    try {
        const stats = await (0, core_1.apiRequest)(`${core_1.DEVICE_API_V1}/db/stats`);
        core_1.logger.info('Database stats', {
            path: stats.path,
            exists: stats.exists,
            sizeBytes: stats.sizeBytes,
            sizeMb: stats.sizeMb,
            tableCount: stats.tableCount,
        });
        if (Array.isArray(stats.tables) && stats.tables.length > 0) {
            core_1.logger.info('Database tables', {
                tables: stats.tables,
            });
        }
    }
    catch (error) {
        if (error instanceof core_1.CLIError)
            throw error;
        throw new core_1.CLIError('Failed to get database stats', 1, {
            error: error.message,
            hint: 'Ensure the agent is running and supports GET /v1/db/stats',
        });
    }
}
/**
 * iotctl db verify [<target>]
 */
async function dbVerify(targetArg) {
    const service = await loadDbBackupService();
    const backupDir = service.getDefaultBackupDir(core_1.DB_PATH);
    const backups = service.listDbBackups({ backupDir });
    const targetPath = resolveBackupPathFromTarget(backups, (0, core_1.normalizePositionalArg)(targetArg) || (0, core_1.getFlagValue)('--target'));
    const result = await service.verifyDbBackup({
        backupPath: targetPath,
        requireMetadata: true,
    });
    if (!result.ok) {
        throw new core_1.CLIError('Backup verification failed', 1, {
            backupPath: targetPath,
            integrity: result.integrity,
            checksumMatch: result.checksumMatch,
        });
    }
    core_1.logger.info('Backup verified', {
        backupPath: targetPath,
        integrity: result.integrity,
        checksumSha256: result.checksumCurrent,
    });
}
/**
 * iotctl db restore [<target>]
 */
async function dbRestore(targetArg) {
    (0, core_1.requireConfirmation)('Database restore will overwrite current SQLite data.');
    const liveAllowed = process.argv.includes('--force-live');
    if (!liveAllowed) {
        const probe = await (0, core_1.apiProbe)(`${core_1.DEVICE_API_V1}/healthy`);
        if (probe.ok) {
            throw new core_1.CLIError('Refusing restore while agent API is reachable', 1, {
                hint: 'Stop the agent first or pass --force-live to override',
            });
        }
    }
    const service = await loadDbBackupService();
    const backupDir = service.getDefaultBackupDir(core_1.DB_PATH);
    const backups = service.listDbBackups({ backupDir });
    const targetPath = resolveBackupPathFromTarget(backups, (0, core_1.normalizePositionalArg)(targetArg) || (0, core_1.getFlagValue)('--target'));
    const result = await service.restoreDbFromBackup({
        dbPath: core_1.DB_PATH,
        backupPath: targetPath,
        backupDir,
        createPreRestoreBackup: true,
    });
    core_1.logger.info('Database restore completed', {
        restoredPath: result.restoredPath,
        preRestoreBackupPath: result.preRestoreBackupPath,
        checksumSha256: result.checksumSha256,
    });
}
/**
 * iotctl db prune [--keep <count>]
 */
async function dbPrune(keepArg) {
    const service = await loadDbBackupService();
    const backupDir = service.getDefaultBackupDir(core_1.DB_PATH);
    const keepValue = (0, core_1.normalizePositionalArg)(keepArg) || (0, core_1.getFlagValue)('--keep') || '24';
    const keep = Number.parseInt(keepValue, 10);
    if (!Number.isFinite(keep) || keep < 1) {
        throw new core_1.CLIError('Invalid --keep value', 1, {
            keep: keepValue,
            hint: 'Use an integer >= 1',
        });
    }
    const result = service.pruneDbBackups({ backupDir, keep });
    core_1.logger.info('Database backup prune complete', {
        backupDir,
        kept: result.kept,
        deletedCount: result.deleted.length,
        deleted: result.deleted,
    });
}
//# sourceMappingURL=db.js.map