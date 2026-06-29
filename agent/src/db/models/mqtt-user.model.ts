import { getDatabase } from '../sqlite.js';

export interface MqttUser {
	id: number;
	username: string;
	is_superuser: boolean;
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

interface MqttUserRow {
	id: number;
	username: string;
	password_hash: string;
	is_superuser: number;
	is_active: number;
	created_at: string;
	updated_at: string;
}

function parseRow(row: MqttUserRow): MqttUser {
	return {
		id: row.id,
		username: row.username,
		is_superuser: row.is_superuser === 1,
		is_active: row.is_active === 1,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export class MqttUserModel {
	private static db() { return getDatabase(); }

	static getAll(): MqttUser[] {
		const rows = this.db()
			.prepare('SELECT id, username, is_superuser, is_active, created_at, updated_at FROM mqtt_users ORDER BY created_at DESC')
			.all() as unknown as MqttUserRow[];
		return rows.map(parseRow);
	}

	static getByUsername(username: string): MqttUser | null {
		const row = this.db()
			.prepare('SELECT id, username, is_superuser, is_active, created_at, updated_at FROM mqtt_users WHERE username = ?')
			.get(username) as unknown as MqttUserRow | undefined;
		return row ? parseRow(row) : null;
	}

	static create(username: string, passwordHash: string, isSuperuser = false): MqttUser {
		const now = new Date().toISOString();
		this.db()
			.prepare('INSERT INTO mqtt_users (username, password_hash, is_superuser, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
			.run(username, passwordHash, isSuperuser ? 1 : 0, now, now);
		return this.getByUsername(username)!;
	}

	static update(username: string, fields: { is_active?: boolean; is_superuser?: boolean; password_hash?: string }): MqttUser | null {
		const sets: string[] = [];
		const values: (string | number | null)[] = [];

		if (fields.is_active !== undefined)    { sets.push('is_active = ?');    values.push(fields.is_active ? 1 : 0); }
		if (fields.is_superuser !== undefined)  { sets.push('is_superuser = ?'); values.push(fields.is_superuser ? 1 : 0); }
		if (fields.password_hash !== undefined) { sets.push('password_hash = ?'); values.push(fields.password_hash); }
		if (sets.length === 0) return this.getByUsername(username);

		sets.push('updated_at = ?');
		values.push(new Date().toISOString(), username);
		this.db().prepare(`UPDATE mqtt_users SET ${sets.join(', ')} WHERE username = ?`).run(...values);
		return this.getByUsername(username);
	}

	static delete(username: string): void {
		this.db().prepare('DELETE FROM mqtt_users WHERE username = ?').run(username);
	}

	static existsByUsername(username: string): boolean {
		const row = this.db()
			.prepare('SELECT 1 FROM mqtt_users WHERE username = ?')
			.get(username);
		return row !== undefined;
	}

	/** Returns all active users with their stored password hash, for use by the auth reconciler. */
	static getAllForReconciler(): { username: string; passwordHash: string; isSuperuser: boolean }[] {
		const rows = this.db()
			.prepare('SELECT username, password_hash, is_superuser FROM mqtt_users WHERE is_active = 1 ORDER BY created_at ASC')
			.all() as { username: string; password_hash: string; is_superuser: number }[];
		return rows.map(r => ({ username: r.username, passwordHash: r.password_hash, isSuperuser: r.is_superuser === 1 }));
	}
}
