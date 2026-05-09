import { existsSync } from 'fs';
import { join } from 'path';
import {
  DB_PATH,
  DEVICE_API_V1,
  CLIError,
  logger,
  apiProbe,
  normalizePositionalArg,
  getFlagValue,
  requireConfirmation,
} from '../core';

type DbBackupServiceModule = {
  getDefaultBackupDir: (dbPath: string) => string;
  createDbBackup: (params: { dbPath: string; backupDir?: string; name?: string }) => Promise<any>;
  listDbBackups: (params: { backupDir: string }) => Array<any>;
  verifyDbBackup: (params: { backupPath: string; requireMetadata?: boolean }) => Promise<any>;
  restoreDbFromBackup: (params: {
    dbPath: string;
    backupPath: string;
    backupDir?: string;
    createPreRestoreBackup?: boolean;
  }) => Promise<any>;
  pruneDbBackups: (params: { backupDir: string; keep: number }) => { deleted: string[]; kept: number };
};

let dbBackupServiceCache: DbBackupServiceModule | null = null;

async function loadDbBackupService(): Promise<DbBackupServiceModule> {
  if (dbBackupServiceCache) {
    return dbBackupServiceCache;
  }

  const candidates = [
    join(__dirname, '..', '..', 'db', 'backup-service.js'),
    join(__dirname, '..', '..', 'src', 'db', 'backup-service.js'),
    join(process.cwd(), 'dist', 'db', 'backup-service.js'),
    join(process.cwd(), 'dist', 'src', 'db', 'backup-service.js'),
    join(process.cwd(), 'src', 'db', 'backup-service.js'),
  ];

  for (const candidatePath of candidates) {
    if (!existsSync(candidatePath)) {
      continue;
    }

    const loaded = require(candidatePath);
    const service = loaded as DbBackupServiceModule;

    if (
      typeof service.createDbBackup === 'function' &&
      typeof service.listDbBackups === 'function' &&
      typeof service.verifyDbBackup === 'function' &&
      typeof service.restoreDbFromBackup === 'function' &&
      typeof service.pruneDbBackups === 'function'
    ) {
      dbBackupServiceCache = service;
      return service;
    }
  }

  throw new CLIError('DB backup service module not found', 1, {
    hint: 'Run npm run build so dist/db/backup-service.js is available',
  });
}

function resolveBackupPathFromTarget(
  backups: Array<{ fileName: string; backupPath: string }>,
  target?: string,
): string {
  if (backups.length === 0) {
    throw new CLIError('No backups found', 1, {
      hint: 'Run iotctl db backup first',
    });
  }

  if (!target || target === 'latest') {
    return backups[0].backupPath;
  }

  if (existsSync(target)) {
    return target;
  }

  const byName = backups.find((item) => item.fileName === target);
  if (byName) {
    return byName.backupPath;
  }

  throw new CLIError('Backup target not found', 1, {
    target,
    hint: 'Use iotctl db list to see available backups',
  });
}

export async function dbBackup(nameArg?: string): Promise<void> {
  const service = await loadDbBackupService();
  const backupDir = service.getDefaultBackupDir(DB_PATH);
  const name = normalizePositionalArg(nameArg) || getFlagValue('--name');

  const result = await service.createDbBackup({
    dbPath: DB_PATH,
    backupDir,
    name,
  });

  logger.info('Database backup created', {
    file: result.fileName,
    path: result.backupPath,
    sizeBytes: result.sizeBytes,
    checksumSha256: result.checksumSha256,
  });
}

export async function dbList(): Promise<void> {
  const service = await loadDbBackupService();
  const backupDir = service.getDefaultBackupDir(DB_PATH);
  const backups = service.listDbBackups({ backupDir });

  if (backups.length === 0) {
    logger.info('No database backups found', { backupDir });
    return;
  }

  logger.info('Database backups', {
    backupDir,
    count: backups.length,
  });

  for (const backup of backups) {
    logger.info(backup.fileName, {
      createdAt: backup.createdAt,
      sizeBytes: backup.sizeBytes,
      checksumSha256: backup.checksumSha256 || 'metadata-missing',
    });
  }
}

export async function dbVerify(targetArg?: string): Promise<void> {
  const service = await loadDbBackupService();
  const backupDir = service.getDefaultBackupDir(DB_PATH);
  const backups = service.listDbBackups({ backupDir });
  const targetPath = resolveBackupPathFromTarget(
    backups,
    normalizePositionalArg(targetArg) || getFlagValue('--target'),
  );

  const result = await service.verifyDbBackup({
    backupPath: targetPath,
    requireMetadata: true,
  });

  if (!result.ok) {
    throw new CLIError('Backup verification failed', 1, {
      backupPath: targetPath,
      integrity: result.integrity,
      checksumMatch: result.checksumMatch,
    });
  }

  logger.info('Backup verified', {
    backupPath: targetPath,
    integrity: result.integrity,
    checksumSha256: result.checksumCurrent,
  });
}

export async function dbRestore(targetArg?: string): Promise<void> {
  requireConfirmation('Database restore will overwrite current SQLite data.');

  const liveAllowed = process.argv.includes('--force-live');
  if (!liveAllowed) {
    const probe = await apiProbe(`${DEVICE_API_V1}/healthy`);
    if (probe.ok) {
      throw new CLIError('Refusing restore while agent API is reachable', 1, {
        hint: 'Stop the agent first or pass --force-live to override',
      });
    }
  }

  const service = await loadDbBackupService();
  const backupDir = service.getDefaultBackupDir(DB_PATH);
  const backups = service.listDbBackups({ backupDir });
  const targetPath = resolveBackupPathFromTarget(
    backups,
    normalizePositionalArg(targetArg) || getFlagValue('--target'),
  );

  const result = await service.restoreDbFromBackup({
    dbPath: DB_PATH,
    backupPath: targetPath,
    backupDir,
    createPreRestoreBackup: true,
  });

  logger.info('Database restore completed', {
    restoredPath: result.restoredPath,
    preRestoreBackupPath: result.preRestoreBackupPath,
    checksumSha256: result.checksumSha256,
  });
}

export async function dbPrune(keepArg?: string): Promise<void> {
  const service = await loadDbBackupService();
  const backupDir = service.getDefaultBackupDir(DB_PATH);
  const keepValue = normalizePositionalArg(keepArg) || getFlagValue('--keep') || '24';
  const keep = Number.parseInt(keepValue, 10);

  if (!Number.isFinite(keep) || keep < 1) {
    throw new CLIError('Invalid --keep value', 1, {
      keep: keepValue,
      hint: 'Use an integer >= 1',
    });
  }

  const result = service.pruneDbBackups({ backupDir, keep });
  logger.info('Database backup prune complete', {
    backupDir,
    kept: result.kept,
    deletedCount: result.deleted.length,
    deleted: result.deleted,
  });
}
