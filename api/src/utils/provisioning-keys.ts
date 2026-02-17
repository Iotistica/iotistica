/**
 * Provisioning Key Management
 * Handles validation, creation, and lifecycle of fleet provisioning keys
 */

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { query } from '../db/connection';
import { logAuditEvent, AuditEventType, AuditSeverity } from './audit-logger';

const BCRYPT_ROUNDS = 10;

export interface ProvisioningKey {
  id: string;
  key_hash: string;
  fleet_uuid: string; // UUID reference to fleets table
  description?: string;
  max_devices: number;
  devices_provisioned: number;
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
    const fastHash = crypto.createHash('sha256').update(key).digest('hex');
    
    const result = await query<ProvisioningKey>(
      `SELECT * FROM provisioning_keys 
       WHERE key_hash_fast = $1
       AND is_active = true 
       AND expires_at > NOW()
       LIMIT 1`,
      [fastHash]
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
    const matches = await bcrypt.compare(key, record.key_hash);
    
    if (!matches) {
      // SHA-256 collision or tampered key - extremely rare
      await logAuditEvent({
        eventType: AuditEventType.PROVISIONING_KEY_INVALID,
        ipAddress,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Bcrypt verification failed after fast hash match' }
      });
      return { valid: false, error: 'Invalid provisioning key' };
    }

    // Check device limit
    if (record.devices_provisioned >= record.max_devices) {
      await logAuditEvent({
        eventType: AuditEventType.PROVISIONING_LIMIT_EXCEEDED,
        ipAddress,
        severity: AuditSeverity.WARNING,
        details: {
          keyId: record.id,
          fleetUuid: record.fleet_uuid,
          limit: record.max_devices,
          provisioned: record.devices_provisioned
        }
      });
      return { 
        valid: false, 
        error: 'Provisioning key device limit exceeded',
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
 * Increment the devices_provisioned counter for a provisioning key
 */
export async function incrementProvisioningKeyUsage(keyId: string): Promise<void> {
  await query(
    `UPDATE provisioning_keys 
     SET devices_provisioned = devices_provisioned + 1 
     WHERE id = $1`,
    [keyId]
  );
}

/**
 * Create a new provisioning key
 */
export async function createProvisioningKey(
  fleetUuid: string,
  maxDevices: number = 100,
  expiresInDays: number = 365,
  description?: string,
  createdBy?: string
): Promise<{ id: string; key: string }> {
  // Generate a secure random key
  const key = crypto.randomBytes(32).toString('hex');
  const keyHash = await bcrypt.hash(key, BCRYPT_ROUNDS);
  const keyHashFast = crypto.createHash('sha256').update(key).digest('hex');
  
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  const result = await query<{ id: string }>(
    `INSERT INTO provisioning_keys (key_hash, key_hash_fast, fleet_uuid, description, max_devices, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [keyHash, keyHashFast, fleetUuid, description, maxDevices, expiresAt, createdBy]
  );

  const keyId = result.rows[0].id;

  await logAuditEvent({
    eventType: AuditEventType.API_KEY_CREATED,
    userId: createdBy,
    severity: AuditSeverity.INFO,
    details: {
      keyId,
      fleetUuid,
      maxDevices,
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
