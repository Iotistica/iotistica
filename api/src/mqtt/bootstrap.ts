/**
 * MQTT Bootstrap Service
 * 
 * Handles initialization of MQTT users and ACLs:
 * 1. Admin user (superuser with full access)
 * 2. Node-RED instance user (instance-level credentials)
 * 
 * Replaces the Kubernetes postgres-init-job
 * Follows FlowFuse pattern of instance-level MQTT credentials
 */

import crypto from 'crypto';
import { query } from '../db/connection';
import logger from '../utils/logger';
import { buildCachedAclRule, seedMqttAclRules, seedMqttSuperuserDecision, seedMqttUserAuthDecision } from './auth-cache';
import { hashPassword } from '../utils/secret-hashing';

interface WarmMqttUserRow {
  username: string;
  is_superuser: boolean;
}

interface WarmMqttAclRow {
  username: string;
  topic: string;
  access: number;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MQTT_AUTH_WARMUP_USER_LIMIT = readPositiveIntEnv('MQTT_AUTH_WARMUP_USER_LIMIT', 100);

/**
 * Initialize MQTT admin user (superuser)
 */
export async function initializeMqttAdmin() {
  const username = process.env.MQTT_USERNAME || 'admin';
  const password = process.env.MQTT_PASSWORD;

  if (!password) {
    logger.warn('MQTT_PASSWORD not set, skipping MQTT admin user creation');
    return;
  }

  try {
    logger.info('Initializing MQTT admin user...');
    
    // Hash password with native scrypt
    const passwordHash = await hashPassword(password);

    // Create/update admin user (idempotent)
    await query(`
      INSERT INTO mqtt_users (username, password_hash, is_superuser, is_active)
      VALUES ($1, $2, TRUE, TRUE)
      ON CONFLICT (username) 
      DO UPDATE SET 
        password_hash = EXCLUDED.password_hash,
        is_superuser = TRUE,
        is_active = TRUE
    `, [username, passwordHash]);

    // Grant full access ACL to all topics (check if exists first)
    const existingAcl = await query(`
      SELECT id FROM mqtt_acls 
      WHERE username = $1 AND topic = '#'
      LIMIT 1
    `, [username]);

    if (existingAcl.rows.length === 0) {
      await query(`
        INSERT INTO mqtt_acls (username, topic, access, priority)
        VALUES ($1, '#', 7, 100)
      `, [username]);
    }

    await Promise.all([
      seedMqttUserAuthDecision(username, password, { isSuperuser: false, result: 'allow' }),
      seedMqttSuperuserDecision(username, { isSuperuser: true, result: 'allow' }),
      seedMqttAclRules(username, { rules: [buildCachedAclRule('#', 7)] }),
    ]);

    logger.info(`MQTT admin user '${username}' initialized`);
  } catch (error) {
    logger.error('Failed to initialize MQTT admin user:', error);
    // Don't throw - not critical for API startup
  }
}

/**
 * Initialize Node-RED instance MQTT credentials
 * Creates instance-specific credentials (FlowFuse pattern)
 * Credentials are stored and returned for Node-RED to use
 */
export async function initializeNodeRedMqttCredentials(): Promise<{ username: string; password: string } | null> {
  const instanceId = process.env.NODERED_INSTANCE_ID || 'default';
  const username = `nodered_${instanceId}`;

  try {
    logger.info(`Initializing Node-RED MQTT credentials for instance: ${instanceId}...`);

    // Check if user already exists
    const existingUser = await query(`
      SELECT username FROM mqtt_users WHERE username = $1
    `, [username]);

    let password: string;

    if (existingUser.rows.length > 0) {
      logger.info(`Node-RED MQTT user '${username}' already exists, skipping creation`);
      // Cannot retrieve existing password because the stored hash is one-way
      // This is expected - credentials should be set once and persisted in environment
      return null;
    }

    // Generate secure random password (32 chars, URL-safe)
    password = crypto.randomBytes(24).toString('base64url');
    
    // Hash password with native scrypt
    const passwordHash = await hashPassword(password);

    // Create Node-RED MQTT user (superuser for full access)
    await query(`
      INSERT INTO mqtt_users (username, password_hash, is_superuser, is_active)
      VALUES ($1, $2, TRUE, TRUE)
    `, [username, passwordHash]);

    // Grant full access ACL (redundant for superuser, but explicit is good)
    await query(`
      INSERT INTO mqtt_acls (username, topic, access, priority)
      VALUES ($1, '#', 3, 100)
    `, [username]);

    await Promise.all([
      seedMqttUserAuthDecision(username, password, { isSuperuser: false, result: 'allow' }),
      seedMqttSuperuserDecision(username, { isSuperuser: true, result: 'allow' }),
      seedMqttAclRules(username, { rules: [buildCachedAclRule('#', 3)] }),
    ]);


    return { username, password };

  } catch (error) {
    logger.error('Failed to initialize Node-RED MQTT credentials:', error);
    return null;
  }
}

export async function warmMqttAuthCaches(): Promise<void> {
  if (MQTT_AUTH_WARMUP_USER_LIMIT <= 0) {
    logger.info('Skipping MQTT auth cache warmup (MQTT_AUTH_WARMUP_USER_LIMIT <= 0)');
    return;
  }

  try {
    const usersResult = await query<WarmMqttUserRow>(
      `SELECT username, is_superuser
       FROM mqtt_users
       WHERE is_active = true
       ORDER BY updated_at DESC NULLS LAST, created_at DESC
       LIMIT $1`,
      [MQTT_AUTH_WARMUP_USER_LIMIT],
    );

    if (usersResult.rows.length === 0) {
      logger.info('MQTT auth cache warmup found no active users');
      return;
    }

    const usernames = usersResult.rows.map((row) => row.username);
    const aclResult = await query<WarmMqttAclRow>(
      `SELECT username, topic, access
       FROM mqtt_acls
       WHERE username = ANY($1::text[])
       ORDER BY username ASC, priority DESC, topic ASC`,
      [usernames],
    );

    const aclMap = new Map<string, ReturnType<typeof buildCachedAclRule>[]>();
    for (const row of aclResult.rows) {
      const rules = aclMap.get(row.username) ?? [];
      rules.push(buildCachedAclRule(row.topic, row.access));
      aclMap.set(row.username, rules);
    }

    await Promise.all(usersResult.rows.map(async (row) => {
      await Promise.all([
        seedMqttSuperuserDecision(row.username, {
          isSuperuser: row.is_superuser,
          result: row.is_superuser ? 'allow' : 'deny',
          error: row.is_superuser ? undefined : 'Not a superuser',
        }),
        seedMqttAclRules(row.username, {
          rules: aclMap.get(row.username) ?? [],
        }),
      ]);
    }));

    logger.info('MQTT auth cache warmup completed', {
      warmedUsers: usersResult.rows.length,
      warmedAclRules: aclResult.rows.length,
      warmupUserLimit: MQTT_AUTH_WARMUP_USER_LIMIT,
    });
  } catch (error) {
    logger.warn('MQTT auth cache warmup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
