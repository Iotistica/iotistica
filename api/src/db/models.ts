/**
 * Database models for device management
 * PostgreSQL queries and data access layer
 */

import { query, transaction } from './connection';
import { PoolClient } from 'pg';
import crypto from 'crypto';
import { DeviceSensorSyncService } from '../services/device-endpoints';
import logger from '../utils/logger';

// Types
export interface Device {
  id: number;
  uuid: string;
  device_name?: string;
  device_type?: string;
  provisioning_state?: string;
  status?: string;
  is_online: boolean;
  is_active: boolean;
  last_connectivity_event?: Date;
  ip_address?: string;
  mac_address?: string;
  os_version?: string;
  agent_version?: string;
  memory_usage?: number;
  memory_total?: number;
  storage_usage?: number;
  storage_total?: number;
  cpu_usage?: number;
  cpu_temp?: number;
  top_processes?: any; // JSONB - stored as any since it's flexible
  network_interfaces?: any; // JSONB - network interface data
  // Security fields
  device_api_key_hash?: string;
  fleet_id?: string;
  provisioned_at?: Date;
  provisioned_by_key_id?: string;
  mqtt_username?: string;
  mqtt_broker_id?: number;
  // VPN fields
  vpn_enabled?: boolean;
  vpn_username?: string;
  vpn_password_hash?: string;
  vpn_last_connected_at?: Date;
  vpn_ip_address?: string;
  vpn_bytes_sent?: number;
  vpn_bytes_received?: number;
  vpn_config_id?: number;
  created_at: Date;
  modified_at: Date;
}

export interface DeviceTargetState {
  id: number;
  device_uuid: string;
  apps: any;
  config: any;
  version: number;
  needs_deployment?: boolean;
  last_deployed_at?: Date;
  deployed_by?: string;
  created_at: Date;
  updated_at: Date;
}

export interface DeviceCurrentState {
  id: number;
  device_uuid: string;
  apps: any;
  config: any;
  system_info: any;
  version?: number; // Which target_state version the device has applied
  reported_at: Date;
}

export interface DeviceMetrics {
  device_uuid: string;
  cpu_usage?: number;
  cpu_temp?: number;
  memory_usage?: number;
  memory_total?: number;
  storage_usage?: number;
  storage_total?: number;
  top_processes?: Array<{
    pid: number;
    name: string;
    cpu: number;
    mem: number;
    command?: string; // Optional
  }>;
  recorded_at: Date;
}

/**
 * Device Model
 */
export class DeviceModel {
  /**
   * Get or create device by UUID
   * Also logs when a device comes back online after being offline
   */
  static async getOrCreate(uuid: string): Promise<Device> {
    // First, check if device exists and was offline
    const existingDevice = await this.getByUuid(uuid);
    const wasOffline = existingDevice && !existingDevice.is_online;
    
    const result = await query<Device>(
      `INSERT INTO devices (uuid, is_online, is_active)
       VALUES ($1, true, true)
       ON CONFLICT (uuid) DO UPDATE SET
         is_online = true,
         last_connectivity_event = CURRENT_TIMESTAMP
       RETURNING *`,
      [uuid]
    );
    
    // Log when device comes back online (only if offline > 5 minutes to avoid noise from connection issues)
    if (wasOffline && existingDevice) {
      const offlineDurationMs = Date.now() - new Date(existingDevice.modified_at).getTime();
      const offlineDurationMin = Math.floor(offlineDurationMs / 1000 / 60);
      
      // Only log if device was offline for more than 5 minutes
      // This avoids false positives from temporary connection pool exhaustion
      if (offlineDurationMin >= 5) {
        // Import at top of file needed
        const { logAuditEvent, AuditEventType, AuditSeverity } = require('../utils/audit-logger');
        const { EventPublisher } = require('../services/event-sourcing');
        
        // 🎉 EVENT SOURCING: Publish device online event
        const eventPublisher = new EventPublisher('device_connectivity');
        await eventPublisher.publish(
          'device.online',
          'device',
          uuid,
          {
            device_name: existingDevice.device_name || 'Unknown',
            was_offline_at: existingDevice.modified_at,
            offline_duration_minutes: offlineDurationMin,
            came_online_at: new Date().toISOString(),
            reason: 'Device resumed communication'
          },
          {
            metadata: {
              detection_method: 'heartbeat_received',
              last_seen: existingDevice.last_connectivity_event
            }
          }
        );
        
        await logAuditEvent({
          eventType: AuditEventType.DEVICE_ONLINE,
          deviceUuid: uuid,
          severity: AuditSeverity.INFO,
          details: {
            deviceName: existingDevice.device_name || 'Unknown',
            wasOfflineAt: existingDevice.modified_at,
            offlineDurationMinutes: offlineDurationMin,
            cameOnlineAt: new Date().toISOString()
          }
        });
        
        logger.info('Device came back online', {
          deviceName: existingDevice.device_name || uuid.substring(0, 8),
          deviceUuid: uuid,
          offlineDurationMinutes: offlineDurationMin,
          wasOfflineAt: existingDevice.modified_at,
          cameOnlineAt: new Date().toISOString()
        });
      }
    }
    
    return result.rows[0];
  }

  /**
   * Get device by UUID
   */
  static async getByUuid(uuid: string): Promise<Device | null> {
    const result = await query<Device>(
      'SELECT * FROM devices WHERE uuid = $1',
      [uuid]
    );
    return result.rows[0] || null;
  }

  /**
   * List all devices
   */
  static async list(filters: {
    isOnline?: boolean;
    isActive?: boolean;
  } = {}): Promise<Device[]> {
    let sql = 'SELECT * FROM devices WHERE 1=1';
    const params: any[] = [];

    if (filters.isOnline !== undefined) {
      params.push(filters.isOnline);
      sql += ` AND is_online = $${params.length}`;
    }

    if (filters.isActive !== undefined) {
      params.push(filters.isActive);
      sql += ` AND is_active = $${params.length}`;
    }

    sql += ' ORDER BY created_at DESC';

    const result = await query<Device>(sql, params);
    return result.rows;
  }

  /**
   * Update device info
   */
  static async update(uuid: string, data: Partial<Device>): Promise<Device> {
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && key !== 'uuid' && key !== 'id') {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    });

    values.push(uuid);

    const result = await query<Device>(
      `UPDATE devices SET ${fields.join(', ')} WHERE uuid = $${paramIndex} RETURNING *`,
      values
    );

    return result.rows[0];
  }

  /**
   * Upsert device - insert or update with all fields atomically
   */
  static async upsert(uuid: string, data: Partial<Device>): Promise<Device> {
    const insertFields: string[] = ['uuid'];
    const insertPlaceholders: string[] = ['$1'];
    const updateFields: string[] = [];
    const values: any[] = [uuid];
    let paramIndex = 2;

    // Build field lists for INSERT and UPDATE
    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && key !== 'uuid' && key !== 'id') {
        insertFields.push(key);
        insertPlaceholders.push(`$${paramIndex}`);
        updateFields.push(`${key} = EXCLUDED.${key}`);
        values.push(value);
        paramIndex++;
      }
    });

    const result = await query<Device>(
      `INSERT INTO devices (${insertFields.join(', ')})
       VALUES (${insertPlaceholders.join(', ')})
       ON CONFLICT (uuid) DO UPDATE SET
         ${updateFields.join(', ')}
       RETURNING *`,
      values
    );

    return result.rows[0];
  }

  /**
   * Mark device as offline
   */
  static async markOffline(uuid: string): Promise<void> {
    await query(
      'UPDATE devices SET is_online = false WHERE uuid = $1',
      [uuid]
    );
  }

  /**
   * Delete device
   */
  static async delete(uuid: string): Promise<void> {
    await query('DELETE FROM devices WHERE uuid = $1', [uuid]);
  }
}

/**
 * Device Target State Model
 */
export class DeviceTargetStateModel {
  /**
   * Get target state for device
   */
  static async get(deviceUuid: string): Promise<DeviceTargetState | null> {
    const result = await query<DeviceTargetState>(
      'SELECT * FROM device_target_state WHERE device_uuid = $1',
      [deviceUuid]
    );
    return result.rows[0] || null;
  }

  /**
   * Set target state for device (without deploying)
   * This marks the state as needing deployment
   */
  static async set(
    deviceUuid: string,
    apps: any,
    config: any = {},
    needsDeployment: boolean = false // Default to false for initial setup
  ): Promise<DeviceTargetState> {
    // Ensure device exists
    await DeviceModel.getOrCreate(deviceUuid);

    const result = await query<DeviceTargetState>(
      `INSERT INTO device_target_state (device_uuid, apps, config, version, needs_deployment, updated_at)
       VALUES ($1, $2, $3, 1, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (device_uuid) DO UPDATE SET
         apps = $2,
         config = $3,
         needs_deployment = $4,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [deviceUuid, JSON.stringify(apps), JSON.stringify(config), needsDeployment]
    );

    return result.rows[0];
  }

  /**
   * Deploy target state to device
   * This increments version so device will pick up changes
   * Also syncs config.endpoints to device_sensors table
   */
  static async deploy(
    deviceUuid: string,
    deployedBy: string = 'system'
  ): Promise<DeviceTargetState> {
    const result = await query<DeviceTargetState>(
      `UPDATE device_target_state SET
         version = version + 1,
         needs_deployment = false,
         last_deployed_at = CURRENT_TIMESTAMP,
         deployed_by = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE device_uuid = $1
       RETURNING *`,
      [deviceUuid, deployedBy]
    );

    if (result.rows.length === 0) {
      throw new Error(`Device ${deviceUuid} has no target state to deploy`);
    }

    const deployedState = result.rows[0];

    // Sync config.endpoints to device_sensors table
    if (deployedState.config && deployedState.config.endpoints) {
      const syncService = new DeviceSensorSyncService();
      await syncService.syncConfigToTable(
        deviceUuid,
        deployedState.config.endpoints,
        deployedState.version,
        deployedBy
      );
    }

    return deployedState;
  }

  /**
   * Clear target state
   */
  static async clear(deviceUuid: string): Promise<void> {
    await query(
      `UPDATE device_target_state SET apps = '{}', config = '{}', updated_at = CURRENT_TIMESTAMP
       WHERE device_uuid = $1`,
      [deviceUuid]
    );
  }

  /**
   * Generate ETag for target state
   */


static generateETag(state: DeviceTargetState): string {
  const payload = JSON.stringify({
    version: state.version,
    apps: state.apps,
    config: state.config,
  });
  return crypto.createHash('sha1').update(payload).digest('hex');
}

}

/**
 * Device Current State Model
 */
export class DeviceCurrentStateModel {
  /**
   * Get current state for device
   */
  static async get(deviceUuid: string): Promise<DeviceCurrentState | null> {
    const result = await query<DeviceCurrentState>(
      'SELECT * FROM device_current_state WHERE device_uuid = $1',
      [deviceUuid]
    );
    return result.rows[0] || null;
  }

  /**
   * Update current state
   */
  static async update(
    deviceUuid: string,
    apps: any,
    config: any = {},
    systemInfo: any = {},
    version?: number
  ): Promise<DeviceCurrentState> {
    // Ensure device exists
    await DeviceModel.getOrCreate(deviceUuid);

    const result = await query<DeviceCurrentState>(
      `INSERT INTO device_current_state (device_uuid, apps, config, system_info, version, reported_at)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (device_uuid) DO UPDATE SET
         apps = $2,
         config = $3,
         system_info = $4,
         version = $5,
         reported_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [deviceUuid, JSON.stringify(apps), JSON.stringify(config), JSON.stringify(systemInfo), version || 0]
    );

    return result.rows[0];
  }
}

/**
 * Device Metrics Model
 */
export class DeviceMetricsModel {
  /**
   * Record device metrics
   */
  static async record(deviceUuid: string, metrics: Partial<DeviceMetrics>): Promise<void> {
    await query(
      `INSERT INTO device_metrics (
        device_uuid, cpu_usage, cpu_temp, memory_usage, memory_total,
        storage_usage, storage_total, top_processes, recorded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
      [
        deviceUuid,
        metrics.cpu_usage,
        metrics.cpu_temp,
        metrics.memory_usage,
        metrics.memory_total,
        metrics.storage_usage,
        metrics.storage_total,
        metrics.top_processes ? JSON.stringify(metrics.top_processes) : null,
      ]
    );

    // Also update device table with latest metrics
    await DeviceModel.update(deviceUuid, {
      cpu_usage: metrics.cpu_usage,
      cpu_temp: metrics.cpu_temp,
      memory_usage: metrics.memory_usage,
      memory_total: metrics.memory_total,
      storage_usage: metrics.storage_usage,
      storage_total: metrics.storage_total,
    } as Partial<Device>);
  }

  /**
   * Get recent metrics for device
   */
  static async getRecent(deviceUuid: string, limit: number = 100): Promise<DeviceMetrics[]> {
    const result = await query<DeviceMetrics>(
      `SELECT * FROM device_metrics 
       WHERE device_uuid = $1 
       ORDER BY recorded_at DESC 
       LIMIT $2`,
      [deviceUuid, limit]
    );
    return result.rows;
  }

  /**
   * Get metrics by time range with optional sampling
   */
  static async getByTimeRange(
    deviceUuid: string, 
    startTime: Date, 
    endTime: Date,
    maxPoints: number = 60
  ): Promise<DeviceMetrics[]> {
    const totalMinutes = Math.floor((endTime.getTime() - startTime.getTime()) / 60000);
    const interval = Math.max(1, Math.floor(totalMinutes / maxPoints));
    
    const result = await query<DeviceMetrics>(
      `WITH numbered AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY recorded_at) as rn
        FROM device_metrics 
        WHERE device_uuid = $1 
          AND recorded_at >= $2 
          AND recorded_at <= $3
      )
      SELECT * FROM numbered 
      WHERE rn % $4 = 1
      ORDER BY recorded_at ASC`,
      [deviceUuid, startTime, endTime, interval]
    );
    return result.rows;
  }

  /**
   * Clean old metrics (keep last 30 days)
   */
  static async cleanup(daysToKeep: number = 30): Promise<number> {
    const result = await query(
      `DELETE FROM device_metrics 
       WHERE recorded_at < NOW() - INTERVAL '${daysToKeep} days'`
    );
    return result.rowCount || 0;
  }
}

/**
 * Device Logs Model
 */
export class DeviceLogsModel {
  /**
   * Store device logs
   */
  static async store(
    deviceUuid: string,
    logs: Array<{
      serviceName?: string;
      timestamp?: Date;
      message: string;
      isSystem?: boolean;
      isStderr?: boolean;
    }>
  ): Promise<void> {
    if (logs.length === 0) return;

    const values: any[] = [];
    const placeholders: string[] = [];

    logs.forEach((log, index) => {
      const offset = index * 6;
      placeholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`
      );
      values.push(
        deviceUuid,
        log.serviceName || null,
        log.timestamp || new Date(),
        log.message,
        log.isSystem || false,
        log.isStderr || false
      );
    });

    await query(
      `INSERT INTO device_logs (device_uuid, service_name, timestamp, message, is_system, is_stderr)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }

  /**
   * Get logs for device
   */
  static async get(
    deviceUuid: string,
    options: {
      serviceName?: string;
      limit?: number;
      offset?: number;
      since?: Date;
    } = {}
  ): Promise<any[]> {
    let sql = 'SELECT * FROM device_logs WHERE device_uuid = $1';
    const params: any[] = [deviceUuid];
    let paramIndex = 2;

    if (options.serviceName) {
      sql += ` AND service_name = $${paramIndex}`;
      params.push(options.serviceName);
      paramIndex++;
    }

    if (options.since) {
      sql += ` AND timestamp >= $${paramIndex}`;
      params.push(options.since);
      paramIndex++;
    }

    sql += ' ORDER BY timestamp DESC';

    if (options.limit) {
      sql += ` LIMIT $${paramIndex}`;
      params.push(options.limit);
      paramIndex++;
    }

    if (options.offset) {
      sql += ` OFFSET $${paramIndex}`;
      params.push(options.offset);
    }

    const result = await query(sql, params);
    return result.rows;
  }

  /**
   * Clean old logs (keep last 7 days)
   */
  static async cleanup(daysToKeep: number = 7): Promise<number> {
    const result = await query(
      `DELETE FROM device_logs 
       WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'`
    );
    return result.rowCount || 0;
  }
}

export default {
  DeviceModel,
  DeviceTargetStateModel,
  DeviceCurrentStateModel,
  DeviceMetricsModel,
  DeviceLogsModel,
};

// Also export SystemConfigModel
export { SystemConfigModel } from './system-config-model';
