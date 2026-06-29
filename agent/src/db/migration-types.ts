import type { DatabaseSync } from 'node:sqlite';

export type NativeSqliteMigration = {
	name: string;
	up: (db: DatabaseSync) => void;
};
