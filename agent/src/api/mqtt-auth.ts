/**
 * MQTT Authentication Routes
 * 
 * Provides HTTP endpoints for mosquitto-go-auth HTTP backend.
 * Broker calls these endpoints to validate MQTT connections against
 * local SQLite auth tables synced from target endpoints.
 * 
 * HTTP Backend Protocol:
 * - GET /api/mqtt/auth/user?username=...&password=...
 *   Returns: 200 if valid, 401/403/500 otherwise
 * - GET /api/mqtt/auth/acl?username=...&topic=...&acc=...
 *   Returns: 200 if allowed, 401/403/500 otherwise
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getKnex } from '../db/connection';
import * as crypto from 'crypto';

export const router = express.Router();

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Validate MQTT user credentials
 * Called by mosquitto-go-auth HTTP backend for CONNECT
 * 
 * Endpoint: GET /api/mqtt/auth/user?username=...&password=...
 * Response: 200 (valid) or 401/403 (invalid)
 * 
 * Example:
 *   GET /api/mqtt/auth/user?username=sensor1&password=secret123
 *   → Looks up 'sensor1' in mqtt_users, verifies password hash
 */
router.get('/api/mqtt/auth/user', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const username = firstString(
			req.query.username,
			req.query.user,
			req.query.u,
			req.body?.username,
			req.body?.user
		);
		const password = firstString(
			req.query.password,
			req.query.pass,
			req.query.pw,
			req.body?.password,
			req.body?.pass,
			req.body?.pw
		);

		// Validate query parameters
		if (!username || !password) {
			console.warn('MQTT user auth missing credentials', {
				queryKeys: Object.keys(req.query || {}),
				hasBody: !!req.body,
				bodyKeys: req.body ? Object.keys(req.body) : [],
			});
			return res.status(401).json({ error: 'Missing username or password' });
		}

		const knex = getKnex();

		// Look up user in local SQLite
		const user = await knex('mqtt_users')
			.where({ username, is_active: true })
			.first();

		if (!user) {
			return res.status(401).json({ error: 'User not found' });
		}

		// Assume bcrypt hashes (as per mqtt-auth.model.ts, only bcrypt allowed)
		// Try bcrypt verification
		const bcrypt = require('bcrypt');
		const match = await bcrypt.compare(password, user.password_hash);

		if (!match) {
			return res.status(401).json({ error: 'Invalid password' });
		}

		// Valid user and password
		return res.status(200).send('OK');
	} catch (error) {
		// Log error but return 500 to broker (non-fatal auth failure)
		console.error('MQTT user auth error:', error);
		return res.status(500).json({ error: 'Internal server error' });
	}
});

/**
 * Validate MQTT topic access control
 * Called by mosquitto-go-auth HTTP backend for PUBLISH/SUBSCRIBE
 * 
 * Endpoint: GET /api/mqtt/auth/acl?username=...&topic=...&acc=...
 * Parameters:
 *   - username: MQTT username
 *   - topic: Topic being accessed
 *   - acc: Access level (1=read, 2=write, 3=both)
 * 
 * Response: 200 (allowed) or 401/403 (denied)
 * 
 * Example:
 *   GET /api/mqtt/auth/acl?username=sensor1&topic=sensors/temp&acc=2
 *   → Checks if sensor1 can write to sensors/temp
 */
router.get('/api/mqtt/auth/acl', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const username = firstString(
			req.query.username,
			req.query.user,
			req.query.u,
			req.body?.username,
			req.body?.user
		);
		const topic = firstString(
			req.query.topic,
			req.query.t,
			req.body?.topic,
			req.body?.t
		);
		const accStr = firstString(
			req.query.acc,
			req.query.access,
			req.query.acl,
			req.body?.acc,
			req.body?.access,
			req.body?.acl
		);

		if (!username) {
			console.warn('MQTT ACL auth missing username', {
				queryKeys: Object.keys(req.query || {}),
				hasBody: !!req.body,
				bodyKeys: req.body ? Object.keys(req.body) : [],
			});
			return res.status(401).json({ error: 'Missing username' });
		}

		const knex = getKnex();

		// Superusers bypass topic-specific ACL checks and may be queried
		// without topic/acc fields depending on broker/plugin behavior.
		const superuser = await knex('mqtt_users')
			.where({ username, is_superuser: true, is_active: true })
			.first();

		if (superuser) {
			return res.status(200).send('OK');
		}

		// Validate query parameters
		if (!topic || !accStr) {
			console.warn('MQTT ACL auth missing parameters', {
				queryKeys: Object.keys(req.query || {}),
				hasBody: !!req.body,
				bodyKeys: req.body ? Object.keys(req.body) : [],
				usernamePresent: true,
				topicPresent: !!topic,
				accPresent: !!accStr,
			});
			return res.status(401).json({ error: 'Missing username, topic, or acc' });
		}

		const acc = parseInt(accStr, 10);
		if (isNaN(acc) || ![1, 2, 3].includes(acc)) {
			return res.status(400).json({ error: 'Invalid access level (must be 1, 2, or 3)' });
		}

		// Check ACL for this user/topic/access combination
		const acl = await knex('mqtt_acls')
			.where({ username, topic })
			.where('access', '>=', acc)  // access >= requested level
			.first();

		if (!acl) {
			return res.status(403).json({ error: 'Topic not allowed for user' });
		}

		// Access allowed
		return res.status(200).send('OK');
	} catch (error) {
		// Log error but return 500 to broker (non-fatal auth failure)
		console.error('MQTT ACL auth error:', error);
		return res.status(500).json({ error: 'Internal server error' });
	}
});

/**
 * List all MQTT users
 * 
 * Endpoint: GET /api/mqtt/users
 * Response: 200 with array of users (username, is_superuser, is_active, created_at)
 * 
 * Example:
 *   GET /api/mqtt/users
 *   → Returns all users in local SQLite mqtt_users table
 */
router.get('/api/mqtt/users', async (req: Request, res: Response, next: NextFunction) => {
	try {
		const knex = getKnex();

		// Fetch all users from local SQLite
		const users = await knex('mqtt_users')
			.select(['username', 'is_superuser', 'is_active', 'created_at'])
			.orderBy('created_at', 'desc');

		return res.status(200).json({
			count: users.length,
			users: users
		});
	} catch (error) {
		console.error('MQTT users list error:', error);
		return res.status(500).json({ error: 'Internal server error' });
	}
});
