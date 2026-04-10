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


    return { username, password };

  } catch (error) {
    logger.error('Failed to initialize Node-RED MQTT credentials:', error);
    return null;
  }
}
