import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { getDatabasePath } from './db-path';
import { closeDatabase, getDatabase } from './sqlite';
import { runMigrations } from './migration-runner';

export { getDatabasePath };

/**
 * Initialize the database and run migrations
 * Should be called once at application startup
 */
export const initialized = async (logger?: AgentLogger): Promise<void> => {
	const db = getDatabase();

	// Run all pending migrations.
	// If lock is held by another process, this will fail fast instead of risking corruption.
	try {
		runMigrations(db, logger);
	} catch (err: any) {
		logger?.errorSync('Database migration failed', err instanceof Error ? err : new Error(String(err)), {
			component: LogComponents.database,
			error: err.message,
			path: getDatabasePath(),
		});
		throw err;
	}
	
	// CRITICAL: Check database integrity after migrations
	// Edge devices: SD card corruption, power loss, flash wear
	// Fail fast > silent corruption leading to data loss or mysterious errors
	try {
		const result = db.pragma('integrity_check', { simple: true });
		const integrityCheck = Array.isArray(result) ? result[0] : result;
		
		if (integrityCheck !== 'ok') {
			// Corruption detected - log details and fail fast
			const errorMessage = `Database corruption detected: ${JSON.stringify(integrityCheck)}. ` +
				`Common causes: SD card failure, power loss, flash wear. ` +
				`Recovery: Restore from backup or delete ${getDatabasePath()} to reinitialize.`;
			
			logger?.errorSync('Database corruption detected!', undefined, {
				component: LogComponents.database,
				path: getDatabasePath(),
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
		db.pragma('wal_checkpoint(TRUNCATE)');
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
		path: getDatabasePath(),
		readonly: process.env.SQLITE_READONLY_MODE === 'true',
	});
};
/**
 * Factory reset - safely clear all device data
 * Used during re-provisioning or device wipe
 */
export async function factoryReset(logger?: AgentLogger): Promise<void> {
	const db = getDatabase();
	const reset = db.transaction(() => {
		db.prepare('DELETE FROM agent').run();
		db.prepare('DELETE FROM message_buffer').run();
	});

	logger?.warnSync('Performing factory reset - clearing all device data', {
		component: LogComponents.database,
	});

	reset.immediate();
	
	logger?.infoSync('Factory reset complete', {
		component: LogComponents.database,
	});
}

/**
 * Gracefully close the database connection
 */
export async function close(): Promise<void> {
	closeDatabase();
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
			const db = getDatabase();
			db.pragma('wal_checkpoint(TRUNCATE)');
			if (signal) {
				console.log(`[${signal}] WAL checkpoint completed - data flushed to main DB`);
			}
		} catch (checkpointErr: any) {
			console.error(`WAL checkpoint failed during shutdown:`, checkpointErr.message);
			// Continue with shutdown even if checkpoint fails
		}
		
		closeDatabase();
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
