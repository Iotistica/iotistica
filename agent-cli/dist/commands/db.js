"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbBackup = dbBackup;
exports.dbList = dbList;
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
        (0, path_1.join)(__dirname, '..', '..', 'db', 'backup-service.js'),
        (0, path_1.join)(__dirname, '..', '..', 'src', 'db', 'backup-service.js'),
        (0, path_1.join)(process.cwd(), 'dist', 'db', 'backup-service.js'),
        (0, path_1.join)(process.cwd(), 'dist', 'src', 'db', 'backup-service.js'),
        (0, path_1.join)(process.cwd(), 'src', 'db', 'backup-service.js'),
    ];
    for (const candidatePath of candidates) {
        if (!(0, fs_1.existsSync)(candidatePath)) {
            continue;
        }
        const loaded = require(candidatePath);
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
        hint: 'Run npm run build so dist/db/backup-service.js is available',
    });
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
        hint: 'Use iotctl db list to see available backups',
    });
}
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
async function dbList() {
    const service = await loadDbBackupService();
    const backupDir = service.getDefaultBackupDir(core_1.DB_PATH);
    const backups = service.listDbBackups({ backupDir });
    if (backups.length === 0) {
        core_1.logger.info('No database backups found', { backupDir });
        return;
    }
    core_1.logger.info('Database backups', {
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