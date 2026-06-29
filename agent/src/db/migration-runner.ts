import type { DatabaseSync } from 'node:sqlite';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { nativeMigrations } from './native-migrations.js';
import { transact } from './sqlite';

const MIGRATION_LOCK_INDEX = 1;
const MIGRATION_TABLE = 'schema_migrations';
const MIGRATION_LOCK_TABLE = 'schema_migrations_lock';
const LEGACY_MIGRATION_TABLE = 'knex_migrations';
const LEGACY_MIGRATION_LOCK_TABLE = 'knex_migrations_lock';
const INITIAL_SCHEMA_MIGRATION = '20260312020000_squashed_initial_schema.js';

function tableExists(db: DatabaseSync, tableName: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get(tableName);

	return Boolean(row);
}

function hasCoreSchemaTables(db: DatabaseSync): boolean {
	const requiredTables = ['agent', 'endpoints', 'endpoint_outputs', 'stateSnapshot'];
	return requiredTables.every((tableName) => tableExists(db, tableName));
}

function ensureLockRow(db: DatabaseSync, tableName: string): void {
	const lockRow = db
		.prepare(`SELECT is_locked FROM ${tableName} WHERE "index" = ?`)
		.get(MIGRATION_LOCK_INDEX);

	if (!lockRow) {
		db.prepare(`INSERT INTO ${tableName} ("index", is_locked) VALUES (?, 0)`).run(MIGRATION_LOCK_INDEX);
	}
}

function migrateLegacyHistoryTables(db: DatabaseSync): void {
	const hasNewHistory = tableExists(db, MIGRATION_TABLE);
	const hasLegacyHistory = tableExists(db, LEGACY_MIGRATION_TABLE);
	const hasNewLock = tableExists(db, MIGRATION_LOCK_TABLE);
	const hasLegacyLock = tableExists(db, LEGACY_MIGRATION_LOCK_TABLE);

	if (!hasNewHistory && hasLegacyHistory) {
		db.exec(`ALTER TABLE ${LEGACY_MIGRATION_TABLE} RENAME TO ${MIGRATION_TABLE}`);
	}

	if (!hasNewLock && hasLegacyLock) {
		db.exec(`ALTER TABLE ${LEGACY_MIGRATION_LOCK_TABLE} RENAME TO ${MIGRATION_LOCK_TABLE}`);
	}
}

function ensureMigrationTables(db: DatabaseSync): void {
	migrateLegacyHistoryTables(db);

	db.exec(`
		CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name VARCHAR(255),
			batch INTEGER,
			migration_time DATETIME
		);
		CREATE TABLE IF NOT EXISTS ${MIGRATION_LOCK_TABLE} (
			"index" INTEGER PRIMARY KEY AUTOINCREMENT,
			is_locked INTEGER
		);
	`);

	ensureLockRow(db, MIGRATION_LOCK_TABLE);

	if (tableExists(db, LEGACY_MIGRATION_TABLE)) {
		const legacyRows = db
			.prepare(`SELECT name, batch, migration_time FROM ${LEGACY_MIGRATION_TABLE} ORDER BY id ASC`)
			.all() as unknown as Array<{ name: string; batch: number | null; migration_time: string | null }>;
		const hasMigration = db.prepare(`SELECT 1 FROM ${MIGRATION_TABLE} WHERE name = ? LIMIT 1`);
		const insertMigration = db.prepare(`
			INSERT INTO ${MIGRATION_TABLE} (name, batch, migration_time)
			VALUES (?, ?, ?)
		`);

		for (const row of legacyRows) {
			if (!hasMigration.get(row.name)) {
				insertMigration.run(row.name, row.batch, row.migration_time);
			}
		}

		db.exec(`DROP TABLE ${LEGACY_MIGRATION_TABLE}`);
	}

	if (tableExists(db, LEGACY_MIGRATION_LOCK_TABLE)) {
		const legacyLock = db
			.prepare(`SELECT is_locked FROM ${LEGACY_MIGRATION_LOCK_TABLE} WHERE "index" = ? LIMIT 1`)
			.get(MIGRATION_LOCK_INDEX) as { is_locked?: number } | undefined;

		if (legacyLock && typeof legacyLock.is_locked === 'number') {
			db.prepare(`UPDATE ${MIGRATION_LOCK_TABLE} SET is_locked = ? WHERE "index" = ?`)
				.run(legacyLock.is_locked, MIGRATION_LOCK_INDEX);
		}

		db.exec(`DROP TABLE ${LEGACY_MIGRATION_LOCK_TABLE}`);
	}
}

function acquireMigrationLock(db: DatabaseSync, logger?: AgentLogger): void {
	ensureMigrationTables(db);

	if (process.env.FORCE_MIGRATION_UNLOCK === 'true') {
		logger?.warnSync('Force unlocking migration lock (FORCE_MIGRATION_UNLOCK=true)', {
			component: LogComponents.database,
			message: 'This should only be used for manual recovery after agent crash',
		});
		db.prepare(`UPDATE ${MIGRATION_LOCK_TABLE} SET is_locked = 0 WHERE "index" = ?`).run(MIGRATION_LOCK_INDEX);
	}

	transact(db, () => {
		const row = db
			.prepare(`SELECT is_locked FROM ${MIGRATION_LOCK_TABLE} WHERE "index" = ?`)
			.get(MIGRATION_LOCK_INDEX) as { is_locked?: number } | undefined;

		if (row?.is_locked) {
			throw new Error('Migration lock is held by another process');
		}

		db.prepare(`UPDATE ${MIGRATION_LOCK_TABLE} SET is_locked = 1 WHERE "index" = ?`).run(MIGRATION_LOCK_INDEX);
	}, 'IMMEDIATE');
}

function releaseMigrationLock(db: DatabaseSync): void {
	db.prepare(`UPDATE ${MIGRATION_LOCK_TABLE} SET is_locked = 0 WHERE "index" = ?`).run(MIGRATION_LOCK_INDEX);
}

export function runMigrations(db: DatabaseSync, logger?: AgentLogger): void {
	acquireMigrationLock(db, logger);

	try {
		const appliedNames = new Set(
			(db.prepare(`SELECT name FROM ${MIGRATION_TABLE} ORDER BY id ASC`).all() as unknown as Array<{ name: string }>).
				map((row) => row.name)
		);

		if (appliedNames.has(INITIAL_SCHEMA_MIGRATION) && !hasCoreSchemaTables(db)) {
			appliedNames.delete(INITIAL_SCHEMA_MIGRATION);
			logger?.warnSync('Initial schema migration marked applied but core tables are missing; reapplying schema bootstrap', {
				component: LogComponents.database,
				migration: INITIAL_SCHEMA_MIGRATION,
			});
		}

		const pendingMigrations = nativeMigrations.filter((migration) => !appliedNames.has(migration.name));

		if (pendingMigrations.length === 0) {
			logger?.debugSync('Database already at latest schema', {
				component: LogComponents.database,
			});
			return;
		}

		const batchRow = db.prepare(`SELECT MAX(batch) AS batch FROM ${MIGRATION_TABLE}`).get() as { batch?: number | null };
		const batch = (batchRow?.batch ?? 0) + 1;
		const recordMigration = db.prepare(`
			INSERT INTO ${MIGRATION_TABLE} (name, batch, migration_time)
			VALUES (?, ?, CURRENT_TIMESTAMP)
		`);

		for (const migration of pendingMigrations) {
			transact(db, () => {
				migration.up(db);
				recordMigration.run(migration.name, batch);
			}, 'IMMEDIATE');

			logger?.infoSync('Applied database migration', {
				component: LogComponents.database,
				migration: migration.name,
				batch,
			});
		}
	} finally {
		releaseMigrationLock(db);
	}
}
