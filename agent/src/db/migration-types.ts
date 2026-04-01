import type Database from 'better-sqlite3';

export type NativeSqliteMigration = {
	name: string;
	up: (db: Database.Database) => void;
};