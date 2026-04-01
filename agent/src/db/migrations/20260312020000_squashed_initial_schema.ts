import type Database from 'better-sqlite3';
import { loadTemplateSql } from '../migration-helpers.js';
import type { NativeSqliteMigration } from '../migration-types.js';

function up(db: Database.Database): void {
	const templateSql = loadTemplateSql()
		.replace(/^\s*BEGIN TRANSACTION;\s*/m, '')
		.replace(/\s*COMMIT;\s*$/m, '');

	db.exec(templateSql);
}

export const migration: NativeSqliteMigration = {
	name: '20260312020000_squashed_initial_schema.js',
	up,
};