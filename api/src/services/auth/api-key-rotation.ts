/**
 * API Key Rotation Service
 * 
 * Automatically rotates device API keys on a scheduled basis for enhanced security.
 * 
 * Features:
 * - Scheduled rotation before key expiry
 * - Grace period for old keys (allows agents time to update)
 * - Automatic notification to agents via MQTT
 * - Rotation history tracking
 * - Emergency key revocation
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { query } from '../../db/connection';
import { getMqttManager } from '../../mqtt';
import logger from '../../utils/logger';

export interface KeyRotationConfig {
  rotationDays: number;          // Days before expiry to rotate
  gracePeriodDays: number;       // Days old key remains valid
  notifyDevice: boolean;         // Notify device via MQTT
  autoRevoke: boolean;           // Auto-revoke old key after grace period
}

export interface DeviceKeyRotation {
  deviceUuid: string;
  deviceName: string;
  oldKeyHash: string;
  newKey: string;
  newKeyHash: string;
  expiresAt: Date;
  gracePeriodEnds: Date;
}

const DEFAULT_CONFIG: KeyRotationConfig = {
  rotationDays: 90,
  gracePeriodDays: 7,
  notifyDevice: true,
  autoRevoke: true
};

/**
 * Generate cryptographically secure API key
 */
function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Rotate API key for a single device
 */
export async function rotateDeviceApiKey(
  deviceUuid: string,
  config: Partial<KeyRotationConfig> = {}
): Promise<DeviceKeyRotation> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Get device info
  const deviceResult = await query(
    `SELECT uuid, name AS device_name, device_api_key_hash, api_key_rotation_days
     FROM agents
     WHERE uuid = $1 AND is_active = true`,
    [deviceUuid]
  );

  if (deviceResult.rows.length === 0) {
    throw new Error(`Device ${deviceUuid} not found or inactive`);
  }

  const device = deviceResult.rows[0];

  // Generate new API key
  const newApiKey = generateApiKey();
  const newKeyHash = await bcrypt.hash(newApiKey, 10);

  // Calculate expiry dates
  const rotationDays = device.api_key_rotation_days || cfg.rotationDays;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + rotationDays);

  const gracePeriodEnds = new Date();
  gracePeriodEnds.setDate(gracePeriodEnds.getDate() + cfg.gracePeriodDays);

  // Update device with new key
  await query(
    `UPDATE agents
     SET 
       device_api_key_hash = $2,
       api_key_expires_at = $3,
       api_key_last_rotated_at = NOW()
     WHERE uuid = $1`,
    [deviceUuid, newKeyHash, expiresAt]
  );

  logger.info('Rotated API key for device', {
    deviceName: device.device_name,
    deviceUuid,
    expiresAt: expiresAt.toISOString(),
    gracePeriodEnds: gracePeriodEnds.toISOString()
  });

  // Notify device via MQTT
  if (cfg.notifyDevice) {
    await notifyDeviceOfRotation(deviceUuid, newApiKey, expiresAt, gracePeriodEnds);
  }

  // Schedule auto-revocation of old key
  if (cfg.autoRevoke) {
    await scheduleOldKeyRevocation(deviceUuid, device.device_api_key_hash, gracePeriodEnds);
  }

  // Log rotation event
  await logRotationEvent(deviceUuid, 'key_rotated', {
    device_name: device.device_name,
    expires_at: expiresAt.toISOString(),
    grace_period_ends: gracePeriodEnds.toISOString()
  });

  return {
    deviceUuid,
    deviceName: device.device_name,
    oldKeyHash: device.device_api_key_hash,
    newKey: newApiKey,
    newKeyHash,
    expiresAt,
    gracePeriodEnds
  };
}

/**
 * Rotate keys for all agents that need rotation
 */
export async function rotateExpiredKeys(
  config: Partial<KeyRotationConfig> = {}
): Promise<DeviceKeyRotation[]> {
  logger.info('Starting automatic API key rotation');

  // Get agents needing rotation (keys expiring soon)
  const result = await query(
    `SELECT uuid, name AS device_name, days_until_expiry
     FROM agents_needing_rotation
     ORDER BY api_key_expires_at ASC`
  );

  if (result.rows.length === 0) {
    logger.info('No agents need key rotation at this time');
    return [];
  }

  logger.info('Found agents needing rotation', { count: result.rows.length });

  const rotations: DeviceKeyRotation[] = [];

  for (const device of result.rows) {
    try {
      const rotation = await rotateDeviceApiKey(device.uuid, config);
      rotations.push(rotation);
      
      logger.info('Device key rotation successful', {
        deviceName: device.device_name,
        daysUntilExpiry: device.days_until_expiry
      });
    } catch (error) {
      logger.error('Device key rotation failed', {
        deviceName: device.device_name,
        error: (error as Error).message
      });
      
      await logRotationEvent(device.uuid, 'rotation_failed', {
        error: (error as Error).message
      });
    }
  }

  logger.info('Rotation complete', {
    successful: rotations.length,
    total: result.rows.length
  });
  
  return rotations;
}

/**
 * Notify device of new API key via MQTT
 */
async function notifyDeviceOfRotation(
  deviceUuid: string,
  newApiKey: string,
  expiresAt: Date,
  gracePeriodEnds: Date
): Promise<void> {
  const mqttManager = getMqttManager();
  
  if (!mqttManager || !mqttManager.isConnected()) {
    logger.warn('MQTT not available, cannot notify device of rotation', { deviceUuid });
    return;
  }

  try {
    mqttManager.publish(
      `device/${deviceUuid}/config/api-key-rotation`,
      {
        event: 'api_key_rotated',
        new_api_key: newApiKey,
        expires_at: expiresAt.toISOString(),
        grace_period_ends: gracePeriodEnds.toISOString(),
        message: 'Your API key has been rotated. Please update your configuration.',
        timestamp: new Date().toISOString()
      }
    );

    logger.info('Notified device of key rotation via MQTT', { deviceUuid });
  } catch (error) {
    logger.error('Failed to notify device via MQTT', {
      deviceUuid,
      error: (error as Error).message
    });
  }
}

/**
 * Schedule revocation of old API key after grace period
 */
async function scheduleOldKeyRevocation(
  deviceUuid: string,
  oldKeyHash: string,
  gracePeriodEnds: Date
): Promise<void> {
  // Mark old key in history as expiring
  await query(
    `UPDATE agent_api_key_history
     SET 
       expires_at = $3,
       is_active = true  -- Still active during grace period
     WHERE agent_uuid = $1 AND key_hash = $2`,
    [deviceUuid, oldKeyHash, gracePeriodEnds]
  );

  logger.info('Scheduled revocation of old key', {
    deviceUuid,
    gracePeriodEnds: gracePeriodEnds.toISOString()
  });
}

/**
 * Revoke old API keys that are past grace period
 */
export async function revokeExpiredKeys(): Promise<number> {
  logger.info('Revoking expired API keys');

  const result = await query(
    `UPDATE agent_api_key_history
     SET 
       is_active = false,
       revoked_at = NOW(),
       revoked_reason = 'Grace period expired'
     WHERE 
       is_active = true
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()
     RETURNING agent_uuid`
  );

  if (result.rows.length > 0) {
    logger.info('Revoked expired API keys', { count: result.rows.length });
    
    // Log revocation events
    for (const row of result.rows) {
      await logRotationEvent(row.agent_uuid, 'old_key_revoked', {
        reason: 'Grace period expired'
      });
    }
  }

  return result.rows.length;
}

/**
 * Emergency revoke API key for a device
 */
export async function emergencyRevokeApiKey(
  deviceUuid: string,
  reason: string
): Promise<void> {
  logger.warn('Emergency revocation initiated', { deviceUuid, reason });

  // Generate new key immediately
  const newApiKey = generateApiKey();
  const newKeyHash = await bcrypt.hash(newApiKey, 10);

  // Update device with new key (0 grace period)
  await query(
    `UPDATE agents
     SET 
       device_api_key_hash = $2,
       api_key_expires_at = NOW() + INTERVAL '90 days',
       api_key_last_rotated_at = NOW()
     WHERE uuid = $1`,
    [deviceUuid, newKeyHash]
  );

  // Revoke all old keys immediately
  await query(
    `UPDATE agent_api_key_history
     SET 
       is_active = false,
       revoked_at = NOW(),
       revoked_reason = $2
     WHERE agent_uuid = $1 AND is_active = true`,
    [deviceUuid, reason]
  );

  // Notify device immediately
  await notifyDeviceOfRotation(
    deviceUuid,
    newApiKey,
    new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    new Date() // Grace period = now (immediate)
  );

  await logRotationEvent(deviceUuid, 'emergency_revocation', { reason });

  logger.info('Emergency revocation complete', {
    deviceUuid,
    newKeyPrefix: newApiKey.substring(0, 16)
  });
}

/**
 * Log rotation event to audit log
 */
async function logRotationEvent(
  deviceUuid: string,
  eventType: string,
  details: any
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (event_type, agent_uuid, severity, details)
       VALUES ($1, $2, $3, $4)`,
      [eventType, deviceUuid, 'info', JSON.stringify(details)]
    );
  } catch (error) {
    logger.error('Failed to log rotation event', {
      deviceUuid,
      eventType,
      error: (error as Error).message
    });
  }
}

/**
 * Get rotation status for a device
 */
export async function getDeviceRotationStatus(deviceUuid: string): Promise<any> {
  const result = await query(
    `SELECT 
       d.uuid,
       d.device_name,
       d.api_key_expires_at,
       d.api_key_last_rotated_at,
       d.api_key_rotation_enabled,
       d.api_key_rotation_days,
       EXTRACT(DAY FROM (d.api_key_expires_at - NOW())) as days_until_expiry,
       (SELECT COUNT(*) FROM agent_api_key_history WHERE agent_uuid = d.uuid) as total_rotations,
       (SELECT COUNT(*) FROM agent_api_key_history WHERE agent_uuid = d.uuid AND is_active = true) as active_keys
     FROM agents d
     WHERE d.uuid = $1`,
    [deviceUuid]
  );

  if (result.rows.length === 0) {
    throw new Error(`Device ${deviceUuid} not found`);
  }

  return result.rows[0];
}

/**
 * Get rotation history for a device
 */
export async function getDeviceRotationHistory(
  deviceUuid: string,
  limit: number = 10
): Promise<any[]> {
  const result = await query(
    `SELECT 
       id,
       key_hash,
       issued_at,
       expires_at,
       revoked_at,
       revoked_reason,
       is_active
     FROM agent_api_key_history
     WHERE agent_uuid = $1
     ORDER BY issued_at DESC
     LIMIT $2`,
    [deviceUuid, limit]
  );

  return result.rows;
}

export default {
  rotateDeviceApiKey,
  rotateExpiredKeys,
  revokeExpiredKeys,
  emergencyRevokeApiKey,
  getDeviceRotationStatus,
  getDeviceRotationHistory
};
