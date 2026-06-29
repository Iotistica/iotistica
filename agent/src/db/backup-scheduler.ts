import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import { BackupScheduleModel } from './models/backup-schedule.model.js';
import { createDbBackup, pruneDbBackups, getDefaultBackupDir } from './backup.js';
import { getDatabasePath } from './db-path.js';

const TICK_INTERVAL_MS = 60_000;

export class BackupScheduler {
	private timer?: NodeJS.Timeout;
	private logger?: AgentLogger;

	constructor(logger?: AgentLogger) {
		this.logger = logger;
	}

	start(): void {
		this.timer = setInterval(() => { void this.tick(); }, TICK_INTERVAL_MS);
		this.logger?.infoSync('Backup scheduler started', {
			component: LogComponents.agent,
			tickIntervalMs: TICK_INTERVAL_MS,
		});
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private async tick(): Promise<void> {
		let schedule;
		try {
			schedule = BackupScheduleModel.get();
		} catch {
			return;
		}

		if (!schedule.enabled) return;

		const now = new Date();
		const nextRunAt = schedule.nextRunAt ? new Date(schedule.nextRunAt) : null;
		if (nextRunAt && nextRunAt > now) return;

		try {
			const dbPath = getDatabasePath();
			const backupDir = getDefaultBackupDir(dbPath);

			const backup = await createDbBackup({ dbPath });

			pruneDbBackups({ backupDir, keep: schedule.keepCount });

			const nextRun = new Date(now.getTime() + schedule.intervalHours * 3_600_000).toISOString();
			BackupScheduleModel.upsert({ lastRunAt: now.toISOString(), nextRunAt: nextRun });

			this.logger?.infoSync('Scheduled backup created', {
				component: LogComponents.agent,
				fileName: backup.fileName,
				nextRunAt: nextRun,
			});
		} catch (error) {
			this.logger?.errorSync('Scheduled backup failed', error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.agent,
			});
			// Advance next_run_at even on failure so we don't retry every tick
			const schedule2 = BackupScheduleModel.get();
			const nextRun = new Date(now.getTime() + schedule2.intervalHours * 3_600_000).toISOString();
			try { BackupScheduleModel.upsert({ nextRunAt: nextRun }); } catch { /* non-fatal */ }
		}
	}
}
