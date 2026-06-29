import { getDatabase } from '../sqlite.js';

export interface BackupSchedule {
	enabled: boolean;
	intervalHours: number;
	keepCount: number;
	lastRunAt: string | null;
	nextRunAt: string | null;
	updatedAt: string;
}

type BackupScheduleRow = {
	id: number;
	enabled: number;
	interval_hours: number;
	keep_count: number;
	last_run_at: string | null;
	next_run_at: string | null;
	updated_at: string;
};

function parseRow(row: BackupScheduleRow): BackupSchedule {
	return {
		enabled: !!row.enabled,
		intervalHours: row.interval_hours,
		keepCount: row.keep_count,
		lastRunAt: row.last_run_at,
		nextRunAt: row.next_run_at,
		updatedAt: row.updated_at,
	};
}

export class BackupScheduleModel {
	static get(): BackupSchedule {
		const row = getDatabase()
			.prepare('SELECT * FROM backup_schedule WHERE id = 1')
			.get() as unknown as BackupScheduleRow;
		return parseRow(row);
	}

	static upsert(patch: Partial<Omit<BackupSchedule, 'updatedAt'>>): BackupSchedule {
		const now = new Date().toISOString();
		const fields: Record<string, string | number | null> = { updated_at: now };

		if (patch.enabled !== undefined) fields.enabled = patch.enabled ? 1 : 0;
		if (patch.intervalHours !== undefined) fields.interval_hours = patch.intervalHours;
		if (patch.keepCount !== undefined) fields.keep_count = patch.keepCount;
		if (patch.lastRunAt !== undefined) fields.last_run_at = patch.lastRunAt;
		if (patch.nextRunAt !== undefined) fields.next_run_at = patch.nextRunAt;

		const cols = Object.keys(fields).map(k => `"${k}" = @${k}`).join(', ');
		getDatabase().prepare(`UPDATE backup_schedule SET ${cols} WHERE id = 1`).run(fields);
		return this.get();
	}
}
