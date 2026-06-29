import { getDatabase } from '../sqlite.js';
import crypto from 'crypto';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class AdminSessionModel {
	static create(username: string): string {
		const db = getDatabase();
		const token = crypto.randomBytes(32).toString('hex');
		const now = Date.now();
		db.prepare(
			`INSERT INTO admin_sessions (token, username, expires_at) VALUES (?, ?, ?)`
		).run(token, username, now + SESSION_TTL_MS);
		return token;
	}

	static find(token: string): { username: string } | null {
		const db = getDatabase();
		const row = db.prepare(
			`SELECT username, expires_at FROM admin_sessions WHERE token = ?`
		).get(token) as { username: string; expires_at: number } | undefined;
		if (!row) return null;
		if (Date.now() > row.expires_at) {
			db.prepare(`DELETE FROM admin_sessions WHERE token = ?`).run(token);
			return null;
		}
		return { username: row.username };
	}

	static delete(token: string): void {
		getDatabase().prepare(`DELETE FROM admin_sessions WHERE token = ?`).run(token);
	}

	static getAll(): { token: string; username: string; created_at: number; expires_at: number }[] {
		return getDatabase()
			.prepare(`SELECT token, username, created_at, expires_at FROM admin_sessions ORDER BY created_at DESC`)
			.all() as { token: string; username: string; created_at: number; expires_at: number }[];
	}

	static deleteByToken(token: string): boolean {
		const info = getDatabase().prepare(`DELETE FROM admin_sessions WHERE token = ?`).run(token);
		return Number(info.changes) > 0;
	}

	static cleanup(): void {
		getDatabase().prepare(`DELETE FROM admin_sessions WHERE expires_at < ?`).run(Date.now());
	}
}
