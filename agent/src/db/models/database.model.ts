import Database from 'better-sqlite3';
import { getDatabase } from '../sqlite';

export class DatabaseModel {
	private static getDb(): Database.Database {
		return getDatabase();
	}

	static getConnection(): Database.Database {
		return this.getDb();
	}

	static ping(): boolean {
		this.getDb().prepare('SELECT 1 AS ok').get();
		return true;
	}
}