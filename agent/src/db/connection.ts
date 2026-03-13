import type { Knex } from 'knex';
import { knex } from 'knex';
import path from 'path';
import * as fs from 'fs';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

// Generic transaction callback - supports return values (sync or async)
type DBTransactionCallback<T = any> = (trx: Knex.Transaction) => Promise<T> | T;

export type Transaction = Knex.Transaction;

// Database path - auto-detect environment
// Docker: /app/data/device.sqlite (matches volume mount)
// Local dev: ./data/device.sqlite (relative to project root)
const getDefaultDatabasePath = (): string => {
	// RELIABLE Docker detection: /.dockerenv is created by Docker runtime
	// Avoid fragile checks like /app/package.json (can exist in non-Docker environments)
	const isDocker = process.env.DEPLOYMENT_TYPE === 'docker';
	
	if (isDocker) {
		return '/app/data/device.sqlite';
	} else {
		// Local development - use relative path
		return path.join(process.cwd(), 'data', 'device.sqlite');
	}
};

// Explicit configuration beats auto-detection
// Edge rule: prefer DATABASE_PATH env var over heuristics
const databasePath = process.env.DATABASE_PATH || getDefaultDatabasePath();

// Ensure the data directory exists
const dataDir = path.dirname(databasePath);
if (!fs.existsSync(dataDir)) {
	fs.mkdirSync(dataDir, { recursive: true });
}

const db = knex({
	client: 'sqlite3',
	connection: {
		filename: databasePath,
	},
	useNullAsDefault: true,
	// CRITICAL for SQLite: Use minimal pool size
	// SQLite has single-writer lock - multiple connections cause lock contention
	// WAL mode still serializes writes, so pool > 1 only adds overhead
	// This dramatically reduces SQLITE_BUSY errors under load
	pool: {
		min: 0, // Let Knex open on demand (min: 1 keeps connection forever, can get stuck after errors)
		max: 1, // Single connection = no lock contention
		acquireTimeoutMillis: 30000,
		idleTimeoutMillis: 30000,
		// Critical for concurrent writes: enable WAL mode and busy timeout
		afterCreate: (conn: any, done: any) => {
			// Enable WAL mode for concurrent read/write
			conn.run('PRAGMA journal_mode = WAL;', (err: any) => {
				if (err) return done(err, conn);
				// Set busy timeout to 5 seconds (SQLite will retry locks)
				conn.run('PRAGMA busy_timeout = 5000;', (err2: any) => {
					if (err2) return done(err2, conn);
					
					// Optional: Enable readonly mode for diagnostics or fail-safe degraded operation
					// Useful for: read-only diagnostics, preventing writes during recovery, fail-safe mode
					// Set SQLITE_READONLY_MODE=true to enable
					if (process.env.SQLITE_READONLY_MODE === 'true') {
						conn.run('PRAGMA query_only = ON;', (err3: any) => {
							done(err3, conn);
						});
					} else {
						done(null, conn);
					}
				});
			});
		},
	},
});

/**
 * Initialize the database and run migrations
 * Should be called once at application startup
 */
export const initialized = async (logger?: AgentLogger): Promise<void> => {
	// CRITICAL: Only clear migration lock if safe
	// Edge scenarios: OTA update, systemd restart, two agents briefly overlapping
	// Clearing active lock = corrupt schema from concurrent migrations
	try {
		const lockRows = await db('knex_migrations_lock').select('*');
		if (lockRows.length > 0 && lockRows[0].is_locked) {
			// Lock is held - check if it's stale or legitimate
			
			// Option 1: Explicit force unlock (manual recovery)
			if (process.env.FORCE_MIGRATION_UNLOCK === 'true') {
				logger?.warnSync('Force unlocking migration lock (FORCE_MIGRATION_UNLOCK=true)', {
					component: LogComponents.database,
					message: 'This should only be used for manual recovery after agent crash',
				});
				await db('knex_migrations_lock').update({ is_locked: 0 });
			} else {
				// Option 2: Skip unlock - let Knex handle it or fail fast
				logger?.warnSync('Migration lock is held - skipping unlock', {
					component: LogComponents.database,
					message: 'Another agent may be running migrations. If this persists, set FORCE_MIGRATION_UNLOCK=true',
					isLocked: lockRows[0].is_locked,
				});
				// Don't clear lock - either:
				// - Another agent is legitimately migrating (let it finish)
				// - Stale lock will cause migration to fail (safer than corruption)
			}
		} else {
			// Lock not held - safe to proceed
			logger?.debugSync('Migration lock not held', {
				component: LogComponents.database,
			});
		}
	} catch (err) {
		// Table doesn't exist yet (first run) - safe to proceed
		logger?.debugSync('Migration lock table does not exist (first run)', {
			component: LogComponents.database,
		});
	}
	
	// Run all pending migrations
	// If lock is held by another process, this will fail (safer than corruption)
	await db.migrate.latest({
		directory: path.join(__dirname, 'migrations'),
		disableMigrationsListValidation: true,
	});
	
	// CRITICAL: Check database integrity after migrations
	// Edge devices: SD card corruption, power loss, flash wear
	// Fail fast > silent corruption leading to data loss or mysterious errors
	try {
		const result = await db.raw('PRAGMA integrity_check;');
		const integrityCheck = result[0]?.integrity_check || result;
		
		if (integrityCheck !== 'ok') {
			// Corruption detected - log details and fail fast
			const errorMessage = `Database corruption detected: ${JSON.stringify(integrityCheck)}. ` +
				`Common causes: SD card failure, power loss, flash wear. ` +
				`Recovery: Restore from backup or delete ${databasePath} to reinitialize.`;
			
			logger?.errorSync('Database corruption detected!', undefined, {
				component: LogComponents.database,
				path: databasePath,
				integrityCheck,
				message: 'SQLite database is corrupted. Common causes: SD card failure, power loss during write, flash wear',
				recovery: 'Restore from backup or reinitialize database',
			});
			
			throw new Error(errorMessage);
		}
		
		logger?.debugSync('Database integrity check passed', {
			component: LogComponents.database,
		});
	} catch (err: any) {
		// If error is from our throw above, re-throw it
		if (err.message.includes('Database corruption detected')) {
			throw err;
		}
		// Otherwise log but continue (integrity_check not supported on older SQLite)
		logger?.warnSync('Database integrity check failed to run', {
			component: LogComponents.database,
			error: err.message,
			message: 'SQLite may be too old to support integrity_check',
		});
	}
	
	// CRITICAL: Checkpoint WAL to prevent unbounded growth
	// Edge devices: Limited storage on SD cards, low read traffic + frequent writes
	// WAL can grow indefinitely if not checkpointed, leading to disk exhaustion
	// 
	// TRUNCATE mode: Move WAL contents to main DB file and truncate WAL to zero bytes
	// ⚠️  TRUNCATE requires exclusive lock and blocks ALL writers
	// ✅  SAFE here because this runs at startup before any concurrent access
	// ❌  NEVER use TRUNCATE during runtime with pool=1 (use PASSIVE or auto-checkpoint)
	try {
		await db.raw('PRAGMA wal_checkpoint(TRUNCATE);');
		logger?.debugSync('WAL checkpoint completed', {
			component: LogComponents.database,
			message: 'WAL file truncated to prevent disk exhaustion',
		});
	} catch (err: any) {
		logger?.warnSync('WAL checkpoint failed', {
			component: LogComponents.database,
			error: err.message,
			message: 'WAL may grow unbounded - consider periodic manual checkpoints',
		});
	}
	
	// Log readonly mode status if enabled
	if (process.env.SQLITE_READONLY_MODE === 'true') {
		logger?.infoSync('SQLite readonly mode enabled (diagnostics/fail-safe)', {
			component: LogComponents.database,
		});
	}
	
	logger?.infoSync('Database initialized', {
		component: LogComponents.database,
		path: databasePath,
		readonly: process.env.SQLITE_READONLY_MODE === 'true',
	});
};

/**
 * Get a query builder for a specific model/table
 */
export function models(modelName: string): Knex.QueryBuilder {
	return db(modelName);
}

/**
 * Upsert (update or insert) a model - ATOMIC version
 * Uses SQLite's native INSERT ... ON CONFLICT ... DO UPDATE
 * 
 * CRITICAL for edge devices: Concurrent writes are common
 * - Multiple metrics collectors writing simultaneously
 * - State reconciliation + health checks
 * - Agent update + normal operations
 * 
 * Old approach had race condition:
 *   Writer 1: UPDATE (0 rows) → INSERT
 *   Writer 2: UPDATE (0 rows) → INSERT
 *   Result: ❌ Constraint violation
 * 
 * New approach is atomic:
 *   Writer 1: INSERT ON CONFLICT UPDATE
 *   Writer 2: INSERT ON CONFLICT UPDATE
 *   Result: ✅ Last writer wins, no errors
 */
export async function upsertModel(
	modelName: string,
	obj: any,
	id: Record<string, unknown>,
	trx?: Knex.Transaction,
): Promise<any> {
	const k = trx || db;
	
	// Get conflict columns (the id fields)
	const conflictColumns = Object.keys(id);
	
	// Merge id into obj (ensure id fields are included in insert)
	const insertData = { ...id, ...obj };
	
	// For SQLite: Use INSERT ... ON CONFLICT ... DO UPDATE
	// This is atomic - no race condition possible
	return k(modelName)
		.insert(insertData)
		.onConflict(conflictColumns)
		.merge(); // merge() = DO UPDATE SET all non-conflict columns
}

/**
 * Execute a callback within a database transaction
 * Supports both sync and async callbacks with return values
 * 
 * CRITICAL for SQLite: Keep transactions ultra-short
 * - DB operations only (no network, logging, timers, retries)
 * - Single connection pool means long transactions block ALL queries
 * - Warns if transaction exceeds 50ms
 * 
 * ❌ BAD: await trx('table').insert(...); await publishMQTT(...);
 * ✅ GOOD: await trx('table').insert(...); // then MQTT outside transaction
 */
export async function transaction<T = any>(
	cb: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
	const start = Date.now();
	return db.transaction(async trx => {
		const result = await cb(trx);
		const duration = Date.now() - start;
		
		// Warn about long transactions that block the single connection
		if (duration > 50) {
			console.warn(`[SQLite] Long transaction detected: ${duration}ms - ` +
				`this blocks ALL database access. Keep transactions DB-only ` +
				`(no network, logging, timers, retries)`);
		}
		
		return result;
	});
}

/**
 * Direct access to the knex instance for advanced queries
 */
export function getKnex(): Knex {
	return db;
}

/**
 * Factory reset - safely clear all device data
 * Used during re-provisioning or device wipe
 */
export async function factoryReset(logger?: AgentLogger): Promise<void> {
	logger?.warnSync('Performing factory reset - clearing all device data', {
		component: LogComponents.database,
	});
	
	await transaction(async (trx) => {
		// Clear all tables in order (respect foreign key constraints if any)
		await trx('device').del();
		await trx('message_buffer').del();
		// Add other tables as needed
	});
	
	logger?.infoSync('Factory reset complete', {
		component: LogComponents.database,
	});
}

/**
 * Gracefully close the database connection
 */
export async function close(): Promise<void> {
	await db.destroy();
}

// Graceful shutdown function (called by main app shutdown coordinator)
// Edge devices can be killed hard (docker stop, systemctl stop, power loss recovery)
let shuttingDown = false;

export async function gracefulShutdown(signal?: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	
	if (signal) {
		console.log(`\n[${signal}] Gracefully shutting down database...`);
	}
	
	try {
		// Give pending queries a chance to complete (200ms grace period)
		// This prevents "aborted" errors for queries in-flight during shutdown
		await new Promise(resolve => setTimeout(resolve, 200));
		
		// CRITICAL: Checkpoint WAL before destroying database to prevent data loss
		// During pod restarts, WAL file may be lost/corrupted if not flushed to main DB
		// TRUNCATE mode ensures all WAL changes are written to main DB file
		try {
			await db.raw('PRAGMA wal_checkpoint(TRUNCATE);');
			if (signal) {
				console.log(`[${signal}] WAL checkpoint completed - data flushed to main DB`);
			}
		} catch (checkpointErr: any) {
			console.error(`WAL checkpoint failed during shutdown:`, checkpointErr.message);
			// Continue with shutdown even if checkpoint fails
		}
		
		await db.destroy();
		if (signal) {
			console.log(`[${signal}] Database connection closed`);
		}
	} catch (err: any) {
		console.error(`Database shutdown error:`, err.message);
		throw err;
	}
}

// NOTE: Signal handlers removed - database shutdown is now coordinated by main app
// This prevents race conditions where DB shuts down before features stop querying

export default db;
