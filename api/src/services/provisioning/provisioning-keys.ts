/**
 * Provisioning Key Management
 * Handles validation, creation, and lifecycle of fleet provisioning keys
 */

import crypto from 'crypto';
import { query } from '../../db/connection';
import { logAuditEvent, AuditEventType, AuditSeverity } from '../../utils/audit-logger';
import {
  hashLegacySha256,
  hashMachineSecret,
  hashMachineSecretDigest,
  verifyMachineSecret,
} from '../../utils/secret-hashing';

export interface ProvisioningKey {
  id: string;
  key_hash: string;
  key_hash_fast?: string;
  fleet_uuid: string; // UUID reference to fleets table
  description?: string;
  max_agents: number;
  agents_provisioned: number;
  expires_at: Date;
  is_active: boolean;
  created_at: Date;
  created_by?: string;
  last_used_at?: Date;
}

export interface ProvisioningKeyValidationResult {
  valid: boolean;
  keyRecord?: ProvisioningKey;
  error?: string;
}

async function verifyLegacyProvisioningKeyWithPgcrypto(key: string, storedHash: string): Promise<boolean> {
  if (!storedHash || storedHash.startsWith('hmac-sha256$')) {
    return false;
  }

  try {
    const result = await query<{ valid: boolean }>(
      'SELECT crypt($1, $2) = $2 AS valid',
      [key, storedHash],
    );
    return result.rows[0]?.valid === true;
  } catch {
    return false;
  }
}

/**
 * Validate a provisioning key against the database
 * Optimized with SHA-256 fast hash for O(1) lookup (300ms) vs O(N) bcrypt (N*300ms)
 */
export async function validateProvisioningKey(
  key: string,
  ipAddress?: string
): Promise<ProvisioningKeyValidationResult> {
  try {
    // Fast lookup using SHA-256 hash (O(1) instead of O(N) bcrypt comparisons)
    const fastHash = hashMachineSecretDigest(key, 'provisioning-key');
    const legacyFastHash = hashLegacySha256(key);
    
    const result = await query<ProvisioningKey>(
      `SELECT * FROM provisioning_keys 
       WHERE key_hash_fast IN ($1, $2)
       AND is_active = true 
       AND expires_at > NOW()
       LIMIT 1`,
      [fastHash, legacyFastHash]
    );

    if (result.rows.length === 0) {
      await logAuditEvent({
        eventType: AuditEventType.PROVISIONING_KEY_INVALID,
        ipAddress,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Invalid provisioning key' }
      });
      return { valid: false, error: 'Invalid provisioning key' };
    }

    // Verify with bcrypt (only 1 comparison now instead of N)
    const record = result.rows[0];
    const verification = await verifyMachineSecret(key, record.key_hash, 'provisioning-key');
    let upgradedHash = verification.upgradedHash;
    let isValid = verification.valid;

    if (!isValid) {
      const legacyValid = await verifyLegacyProvisioningKeyWithPgcrypto(key, record.key_hash);
      if (!legacyValid) {
        await logAuditEvent({
          eventType: AuditEventType.PROVISIONING_KEY_INVALID,
          ipAddress,
          severity: AuditSeverity.WARNING,
          details: { reason: 'Provisioning key verification failed after fast hash match' }
        });
        return { valid: false, error: 'Invalid provisioning key' };
      }

      isValid = true;
      upgradedHash = hashMachineSecret(key, 'provisioning-key');
    }

    if (upgradedHash || record.key_hash_fast !== fastHash) {
      await query(
        `UPDATE provisioning_keys
         SET key_hash = $1, key_hash_fast = $2
         WHERE id = $3`,
        [upgradedHash ?? record.key_hash, fastHash, record.id],
      );
      record.key_hash = upgradedHash ?? record.key_hash;
      record.key_hash_fast = fastHash;
    }

    // Check agent limit
    if (record.agents_provisioned >= record.max_agents) {
      await logAuditEvent({
        eventType: AuditEventType.PROVISIONING_LIMIT_EXCEEDED,
        ipAddress,
        severity: AuditSeverity.WARNING,
        details: {
          keyId: record.id,
          fleetUuid: record.fleet_uuid,
          limit: record.max_agents,
          provisioned: record.agents_provisioned
        }
      });
      return { 
        valid: false, 
        error: 'Provisioning key agent limit exceeded',
        keyRecord: record
      };
    }

    // Check expiration (already checked in query, but double-check for safety)
    if (new Date(record.expires_at) < new Date()) {
      await logAuditEvent({
        eventType: AuditEventType.PROVISIONING_KEY_EXPIRED,
        ipAddress,
        severity: AuditSeverity.WARNING,
        details: {
          keyId: record.id,
          fleetUuid: record.fleet_uuid,
          expiredAt: record.expires_at
        }
      });
      return { 
        valid: false, 
        error: 'Provisioning key has expired',
        keyRecord: record
      };
    }

    // Update last used timestamp
    await query(
      `UPDATE provisioning_keys 
       SET last_used_at = NOW() 
       WHERE id = $1`,
      [record.id]
    );

    return { valid: true, keyRecord: record };
  } catch (error: any) {
    // Distinguish between database errors and validation errors
    const isDatabaseError = error.message?.includes('Connection terminated') || 
                           error.message?.includes('timeout') ||
                           error.message?.includes('ECONNREFUSED');
    
    await logAuditEvent({
      eventType: isDatabaseError ? AuditEventType.PROVISIONING_FAILED : AuditEventType.PROVISIONING_KEY_INVALID,
      ipAddress,
      severity: isDatabaseError ? AuditSeverity.ERROR : AuditSeverity.WARNING,
      details: { 
        error: error.message,
        isDatabaseError,
        reason: isDatabaseError ? 'Database connection error' : 'Validation error'
      }
    });
    throw error;
  }
}

/**
 * Atomically increment the agents_provisioned counter, enforcing max_agents in the DB.
 * Returns true if the increment succeeded, false if the limit was already reached.
 * Using a conditional UPDATE with RETURNING prevents concurrent registrations from
 * exceeding the limit between a separate read and write.
 */
export async function incrementProvisioningKeyUsage(keyId: string): Promise<boolean> {
  const result = await query<{ id: string }>(
    `UPDATE provisioning_keys
     SET agents_provisioned = agents_provisioned + 1
     WHERE id = $1
       AND agents_provisioned < max_agents
     RETURNING id`,
    [keyId]
  );
  return result.rows.length > 0;
}

/**
 * Create a new provisioning key
 */
export async function createProvisioningKey(
  fleetUuid: string,
  maxAgents: number = 100,
  expiresInDays: number = 365,
  description?: string,
  createdBy?: string
): Promise<{ id: string; key: string }> {
  // Generate a secure random key
  const key = crypto.randomBytes(32).toString('hex');
  const keyHash = hashMachineSecret(key, 'provisioning-key');
  const keyHashFast = hashMachineSecretDigest(key, 'provisioning-key');
  
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  const result = await query<{ id: string }>(
    `INSERT INTO provisioning_keys (key_hash, key_hash_fast, fleet_uuid, description, max_agents, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [keyHash, keyHashFast, fleetUuid, description, maxAgents, expiresAt, createdBy]
  );

  const keyId = result.rows[0].id;

  await logAuditEvent({
    eventType: AuditEventType.API_KEY_CREATED,
    userId: createdBy,
    severity: AuditSeverity.INFO,
    details: {
      keyId,
      fleetUuid,
      maxAgents,
      expiresAt: expiresAt.toISOString()
    }
  });

  return { id: keyId, key };
}

/**
 * Revoke a provisioning key
 */
export async function revokeProvisioningKey(keyId: string, reason?: string): Promise<void> {
  await query(
    `UPDATE provisioning_keys 
     SET is_active = false 
     WHERE id = $1`,
    [keyId]
  );

  await logAuditEvent({
    eventType: AuditEventType.API_KEY_REVOKED,
    severity: AuditSeverity.INFO,
    details: { keyId, reason }
  });
}

/**
 * List all provisioning keys for a fleet
 */
export async function listProvisioningKeys(fleetUuid: string): Promise<ProvisioningKey[]> {
  const result = await query<ProvisioningKey>(
    `SELECT * FROM provisioning_keys 
     WHERE fleet_uuid = $1 
     ORDER BY created_at DESC`,
    [fleetUuid]
  );

  return result.rows;
}

export default {
  validateProvisioningKey,
  incrementProvisioningKeyUsage,
  createProvisioningKey,
  revokeProvisioningKey,
  listProvisioningKeys
};
