import type { DatabaseSync } from 'node:sqlite';
import path from 'path';
import * as fs from 'fs';

export function tableExists(db: DatabaseSync, tableName: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get(tableName);

	return Boolean(row);
}

export function columnExists(db: DatabaseSync, tableName: string, columnName: string): boolean {
	if (!tableExists(db, tableName)) {
		return false;
	}

	const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as unknown as Array<{ name: string }>;
	return columns.some((column) => column.name === columnName);
}

export function loadTemplateSql(): string {
	const candidatePaths = [
		path.join(__dirname, 'template.sqlite.sql'),
		path.join(process.cwd(), 'dist', 'db', 'template.sqlite.sql'),
		path.join(process.cwd(), 'src', 'db', 'template.sqlite.sql'),
		'/app/dist/db/template.sqlite.sql',
		'/app/src/db/template.sqlite.sql',
	];

	for (const candidate of candidatePaths) {
		if (fs.existsSync(candidate)) {
			return fs.readFileSync(candidate, 'utf-8');
		}
	}

	throw new Error(
		`template.sqlite.sql not found. Checked paths: ${candidatePaths.join(', ')}`
	);
}
