import type { DatabaseSync } from 'node:sqlite';
import { getDatabase, transact } from '../sqlite';

export type StateSnapshotType = 'target' | 'current' | 'config' | 'apps-target';

export interface StateSnapshotRecord {
	id: number;
	type: StateSnapshotType;
	state: string;
	stateHash?: string | null;
	createdAt?: string | Date | null;
}

export class StateSnapshotModel {
	private static table = 'stateSnapshot';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static getLatest(type: StateSnapshotType): StateSnapshotRecord | null {
		const row = this.getDb()
			.prepare(`
				SELECT id, type, state, stateHash, createdAt
				FROM ${this.table}
				WHERE type = ?
				ORDER BY createdAt DESC
				LIMIT 1
			`)
			.get(type) as unknown as StateSnapshotRecord | undefined;

		return row ?? null;
	}

	static replace(type: StateSnapshotType, state: string, stateHash?: string): void {
		const db = this.getDb();
		transact(db, () => {
			db.prepare(`DELETE FROM ${this.table} WHERE type = ?`).run(type);
			db.prepare(`
				INSERT INTO ${this.table} (type, state, stateHash)
				VALUES (?, ?, ?)
			`).run(type, state, stateHash ?? null);
		});
	}

	static appendAndTrim(type: StateSnapshotType, state: string, stateHash?: string, keepCount: number = 2): void {
		const db = this.getDb();
		transact(db, () => {
			db.prepare(`
				INSERT INTO ${this.table} (type, state, stateHash)
				VALUES (?, ?, ?)
			`).run(type, state, stateHash ?? null);

			const oldSnapshots = db.prepare(`
				SELECT id
				FROM ${this.table}
				WHERE type = ?
				ORDER BY createdAt DESC
				LIMIT -1 OFFSET ?
			`).all(type, keepCount) as unknown as Array<{ id?: number }>;

			const oldIds = oldSnapshots
				.map((snapshot) => snapshot.id)
				.filter((id): id is number => typeof id === 'number');

			if (oldIds.length > 0) {
				const placeholders = oldIds.map(() => '?').join(', ');
				db.prepare(`DELETE FROM ${this.table} WHERE id IN (${placeholders})`).run(...oldIds);
			}
		});
	}
}