import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { DatabaseSync } from 'node:sqlite';

export interface DbBackupMetadata {
	version: 1;
	createdAt: string;
	sourceDbPath: string;
	backupFile: string;
	checksumSha256: string;
	sizeBytes: number;
	integrity: 'ok';
}

export interface DbBackupInfo {
	backupPath: string;
	metadataPath: string;
	fileName: string;
	sizeBytes: number;
	createdAt: string;
	checksumSha256?: string;
}

export interface DbVerificationResult {
	ok: boolean;
	backupPath: string;
	integrity: string;
	checksumCurrent: string;
	checksumExpected?: string;
	checksumMatch: boolean;
}

function ensureDir(dirPath: string): void {
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
}

function formatTimestampForFile(date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

async function hashFileSha256(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = fs.createReadStream(filePath);

		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

function getIntegrityCheck(filePath: string): string {
	const db = new DatabaseSync(filePath);
	try {
		const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
		return row?.integrity_check ?? 'failed';
	} finally {
		db.close();
	}
}

function metadataPathForBackup(backupPath: string): string {
	return `${backupPath}.meta.json`;
}

function readMetadata(backupPath: string): DbBackupMetadata | undefined {
	const metaPath = metadataPathForBackup(backupPath);
	if (!fs.existsSync(metaPath)) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as DbBackupMetadata;
		if (parsed?.version === 1) {
			return parsed;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export function getDefaultBackupDir(dbPath: string): string {
	return path.join(path.dirname(dbPath), 'backups', 'db');
}

export async function createDbBackup(params: {
	dbPath: string;
	backupDir?: string;
	name?: string;
}): Promise<DbBackupInfo> {
	const backupDir = params.backupDir || getDefaultBackupDir(params.dbPath);
	ensureDir(backupDir);

	if (!fs.existsSync(params.dbPath)) {
		throw new Error(`Database file not found: ${params.dbPath}`);
	}

	const baseName = params.name?.trim() || `agent-${formatTimestampForFile()}`;
	const safeName = baseName.endsWith('.sqlite') ? baseName : `${baseName}.sqlite`;
	const backupPath = path.join(backupDir, safeName);
	const tmpPath = `${backupPath}.tmp`;

	// VACUUM INTO creates an online copy of the current database including all
	// committed WAL frames — no separate checkpoint step required.
	const db = new DatabaseSync(params.dbPath);
	try {
		db.exec(`VACUUM INTO '${tmpPath}'`);
	} finally {
		db.close();
	}

	const integrity = getIntegrityCheck(tmpPath);
	if (integrity !== 'ok') {
		fs.rmSync(tmpPath, { force: true });
		throw new Error(`Backup integrity check failed: ${integrity}`);
	}

	const checksumSha256 = await hashFileSha256(tmpPath);
	const sizeBytes = fs.statSync(tmpPath).size;

	const metadata: DbBackupMetadata = {
		version: 1,
		createdAt: new Date().toISOString(),
		sourceDbPath: params.dbPath,
		backupFile: path.basename(backupPath),
		checksumSha256,
		sizeBytes,
		integrity: 'ok',
	};

	fs.renameSync(tmpPath, backupPath);
	const metaPath = metadataPathForBackup(backupPath);
	fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

	return {
		backupPath,
		metadataPath: metaPath,
		fileName: path.basename(backupPath),
		sizeBytes,
		createdAt: metadata.createdAt,
		checksumSha256,
	};
}

export async function verifyDbBackup(params: {
	backupPath: string;
	requireMetadata?: boolean;
}): Promise<DbVerificationResult> {
	if (!fs.existsSync(params.backupPath)) {
		throw new Error(`Backup file not found: ${params.backupPath}`);
	}

	const integrity = getIntegrityCheck(params.backupPath);
	const checksumCurrent = await hashFileSha256(params.backupPath);
	const metadata = readMetadata(params.backupPath);

	if (params.requireMetadata && !metadata) {
		throw new Error(`Backup metadata not found: ${metadataPathForBackup(params.backupPath)}`);
	}

	const checksumExpected = metadata?.checksumSha256;
	const checksumMatch = checksumExpected ? checksumExpected === checksumCurrent : true;
	const ok = integrity === 'ok' && checksumMatch;

	return {
		ok,
		backupPath: params.backupPath,
		integrity,
		checksumCurrent,
		checksumExpected,
		checksumMatch,
	};
}

export function listDbBackups(params: {
	backupDir: string;
}): DbBackupInfo[] {
	if (!fs.existsSync(params.backupDir)) {
		return [];
	}

	return fs
		.readdirSync(params.backupDir)
		.filter((name) => name.endsWith('.sqlite'))
		.map((fileName) => {
			const backupPath = path.join(params.backupDir, fileName);
			const stat = fs.statSync(backupPath);
			const metadata = readMetadata(backupPath);
			return {
				backupPath,
				metadataPath: metadataPathForBackup(backupPath),
				fileName,
				sizeBytes: stat.size,
				createdAt: metadata?.createdAt || stat.mtime.toISOString(),
				checksumSha256: metadata?.checksumSha256,
			} as DbBackupInfo;
		})
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function restoreDbFromBackup(params: {
	dbPath: string;
	backupPath: string;
	backupDir?: string;
	createPreRestoreBackup?: boolean;
}): Promise<{ restoredPath: string; preRestoreBackupPath?: string; checksumSha256: string }> {
	const verification = await verifyDbBackup({
		backupPath: params.backupPath,
		requireMetadata: true,
	});

	if (!verification.ok) {
		throw new Error(
			`Backup verification failed (integrity=${verification.integrity}, checksumMatch=${verification.checksumMatch})`
		);
	}

	let preRestoreBackupPath: string | undefined;
	if (params.createPreRestoreBackup !== false && fs.existsSync(params.dbPath)) {
		const preBackup = await createDbBackup({
			dbPath: params.dbPath,
			backupDir: params.backupDir || getDefaultBackupDir(params.dbPath),
			name: `pre-restore-${formatTimestampForFile()}`,
		});
		preRestoreBackupPath = preBackup.backupPath;
	}

	const dbDir = path.dirname(params.dbPath);
	ensureDir(dbDir);

	const tmpRestorePath = `${params.dbPath}.restore.tmp`;
	fs.copyFileSync(params.backupPath, tmpRestorePath);
	fs.renameSync(tmpRestorePath, params.dbPath);

	for (const suffix of ['-wal', '-shm']) {
		const sidecar = `${params.dbPath}${suffix}`;
		if (fs.existsSync(sidecar)) {
			fs.rmSync(sidecar, { force: true });
		}
	}

	const restoredIntegrity = getIntegrityCheck(params.dbPath);
	if (restoredIntegrity !== 'ok') {
		throw new Error(`Restored database integrity check failed: ${restoredIntegrity}`);
	}

	return {
		restoredPath: params.dbPath,
		preRestoreBackupPath,
		checksumSha256: verification.checksumCurrent,
	};
}

export function pruneDbBackups(params: {
	backupDir: string;
	keep: number;
}): { deleted: string[]; kept: number } {
	if (params.keep < 1) {
		throw new Error('keep must be >= 1');
	}

	const backups = listDbBackups({ backupDir: params.backupDir });
	if (backups.length <= params.keep) {
		return { deleted: [], kept: backups.length };
	}

	const toDelete = backups.slice(params.keep);
	for (const item of toDelete) {
		fs.rmSync(item.backupPath, { force: true });
		fs.rmSync(item.metadataPath, { force: true });
	}

	return {
		deleted: toDelete.map((item) => item.fileName),
		kept: params.keep,
	};
}
