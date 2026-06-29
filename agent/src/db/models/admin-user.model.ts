import { getDatabase } from '../sqlite.js';

export interface User {
	id: number;
	username: string;
	is_superuser: boolean;
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

interface UserRow {
	id: number;
	username: string;
	is_superuser: number;
	is_active: number;
	created_at: string;
	updated_at: string;
}

function parseRow(row: UserRow): User {
	return {
		id: row.id,
		username: row.username,
		is_superuser: row.is_superuser === 1,
		is_active: row.is_active === 1,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export class UserModel {
	private static db() { return getDatabase(); }

	static count(): number {
		const row = this.db().prepare('SELECT COUNT(*) as n FROM users').get() as { n: number };
		return row.n;
	}

	static getAll(): User[] {
		return (this.db()
			.prepare('SELECT id, username, is_superuser, is_active, created_at, updated_at FROM users ORDER BY created_at ASC')
			.all() as unknown as UserRow[]).map(parseRow);
	}

	static getByUsername(username: string): User | null {
		const row = this.db()
			.prepare('SELECT id, username, is_superuser, is_active, created_at, updated_at FROM users WHERE username = ?')
			.get(username) as unknown as UserRow | undefined;
		return row ? parseRow(row) : null;
	}

	static getPasswordHash(username: string): string | null {
		const row = this.db()
			.prepare('SELECT password_hash FROM users WHERE username = ?')
			.get(username) as { password_hash: string } | undefined;
		return row?.password_hash ?? null;
	}

	static create(username: string, passwordHash: string, isSuperuser = false): User {
		const now = new Date().toISOString();
		this.db()
			.prepare('INSERT INTO users (username, password_hash, is_superuser, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
			.run(username, passwordHash, isSuperuser ? 1 : 0, now, now);
		return this.getByUsername(username)!;
	}

	static update(username: string, fields: { is_active?: boolean; is_superuser?: boolean; password_hash?: string }): User | null {
		const sets: string[] = [];
		const values: (string | number | null)[] = [];

		if (fields.is_active !== undefined)     { sets.push('is_active = ?');     values.push(fields.is_active ? 1 : 0); }
		if (fields.is_superuser !== undefined)  { sets.push('is_superuser = ?');  values.push(fields.is_superuser ? 1 : 0); }
		if (fields.password_hash !== undefined) { sets.push('password_hash = ?'); values.push(fields.password_hash); }
		if (sets.length === 0) return this.getByUsername(username);

		sets.push('updated_at = ?');
		values.push(new Date().toISOString(), username);
		this.db().prepare(`UPDATE users SET ${sets.join(', ')} WHERE username = ?`).run(...values);
		return this.getByUsername(username);
	}

	static delete(username: string): void {
		this.db().prepare('DELETE FROM users WHERE username = ?').run(username);
	}

	static existsByUsername(username: string): boolean {
		return this.db().prepare('SELECT 1 FROM users WHERE username = ?').get(username) !== undefined;
	}
}
