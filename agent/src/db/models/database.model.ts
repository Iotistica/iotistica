import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';

export class DatabaseModel {
	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static getConnection(): DatabaseSync {
		return this.getDb();
	}

	static ping(): boolean {
		this.getDb().prepare('SELECT 1 AS ok').get();
		return true;
	}
}