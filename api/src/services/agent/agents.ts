import { randomUUID, randomBytes, createHmac } from 'crypto';
import * as mqtt from 'mqtt';
import { query } from '../../db/connection';
import { logAuditEvent, AuditEventType, AuditSeverity } from '../../utils/audit-logger';
import { EventPublisher } from '../audit/event-sourcing';
import { logger } from '../../utils/logger';
import { SystemConfig } from '../config/system-config';
import { virtualAgentDeployer } from '../provisioning/virtual-agent-deployer';
import { provisioningService } from '../provisioning/register';
import { mqttDeviceTopic } from '../../mqtt/topics';
import { getTenantId } from '../../redis/tenant-keys';
import { getDefaultBrokerConfig, buildBrokerUrl } from '../../utils/mqtt-broker-config';

// ============================================================================
// Agent DB Interfaces
// ============================================================================

export interface Agent {
  id: number;
  uuid: string;
  name?: string;
  type?: string;
  provisioning_state?: string;
  status?: string;
  is_online: boolean;
  is_active: boolean;
  last_connectivity_event?: Date;
  ip_address?: string;
  mac_address?: string;
  location?: string;
  os_version?: string;
  agent_version?: string;
  memory_usage?: number;
  memory_total?: number;
  storage_usage?: number;
  storage_total?: number;
  cpu_usage?: number;
  cpu_temp?: number;
  network_interfaces?: any;
  device_api_key_hash?: string;
  fleet_uuid?: string;
  provisioned_at?: Date;
  provisioned_by_key_id?: string;
  mqtt_username?: string;
  mqtt_broker_id?: number;
  device_public_key?: string;
  pop_verified?: boolean;
  pop_verified_at?: Date;
  last_challenge?: string;
  last_challenge_expires_at?: Date;
  vpn_enabled?: boolean;
  vpn_username?: string;
  vpn_password_hash?: string;
  vpn_last_connected_at?: Date;
  vpn_ip_address?: string;
  vpn_bytes_sent?: number;
  vpn_bytes_received?: number;
  vpn_config_id?: number;
  deployment_status?: 'pending' | 'deploying' | 'running' | 'failed' | 'terminated' | null;
  k8s_namespace?: string | null;
  k8s_pod_name?: string | null;
  helm_release_name?: string | null;
  created_at: Date;
  modified_at: Date;
}

export interface AgentTargetState {
  id: number;
  agent_uuid: string;
  apps: any;
  config: {
    agent?: {
      version?: string;
      update_scheduled_at?: string;
      update_force?: boolean;
      update_issued_at?: number;
      update_expires_at?: number;
      update_signature?: string;
    };
    endpoints?: any[];
    intervals?: any;
    logging?: any;
    features?: any;
    protocols?: any;
    anomaly?: any;
    [key: string]: any;
  };
  version: number;
  needs_deployment?: boolean;
  last_deployed_at?: Date;
  deployed_by?: string;
  created_at: Date;
  updated_at: Date;
}

export interface AgentCurrentState {
  id: number;
  agent_uuid: string;
  apps: any;
  config: any;
  system_info: any;
  version?: number;
  reported_at: Date;
}

export interface AgentMetrics {
  agent_uuid: string;
  cpu_usage?: number;
  cpu_temp?: number;
  memory_usage?: number;
  memory_total?: number;
  storage_usage?: number;
  storage_total?: number;
  recorded_at: Date;
}

// ============================================================================
// AgentModel
// ============================================================================

export class AgentModel {
  /**
   * Get or mark device online by UUID.
   * Does NOT create device if it doesn't exist (prevents empty device records).
   */
  static async getOrCreate(uuid: string): Promise<Agent | null> {
    const existingDevice = await this.getByUuid(uuid);

    if (!existingDevice) {
      logger.warn('Device does not exist - state polling before registration?', {
        deviceUuid: uuid.substring(0, 8) + '...',
        note: 'Device must complete registration before polling state',
      });
      return null;
    }

    const wasOffline = !existingDevice.is_online;

    const isVirtualAgentPending =
      existingDevice.type === 'virtual' && existingDevice.provisioning_state === 'pending';

    if (isVirtualAgentPending) {
      return existingDevice;
    }

    const result = await query<Agent>(
      `UPDATE agents SET
         is_online = true,
         last_connectivity_event = CURRENT_TIMESTAMP
       WHERE uuid = $1
       RETURNING *`,
      [uuid]
    );

    if (wasOffline && existingDevice) {
      const offlineDurationMs = Date.now() - new Date(existingDevice.modified_at).getTime();
      const offlineDurationMin = Math.floor(offlineDurationMs / 1000 / 60);

      if (offlineDurationMin >= 5) {
        const localPublisher = new EventPublisher('device_connectivity');
        await localPublisher.publish(
          'device.online',
          'agent',
          uuid,
          {
            name: existingDevice.name || 'Unknown',
            was_offline_at: existingDevice.modified_at,
            offline_duration_minutes: offlineDurationMin,
            came_online_at: new Date().toISOString(),
            reason: 'Device resumed communication',
          },
          {
            metadata: {
              detection_method: 'heartbeat_received',
              last_seen: existingDevice.last_connectivity_event,
            },
          }
        );

        await logAuditEvent({
          eventType: AuditEventType.DEVICE_ONLINE,
          agentUuid: uuid,
          severity: AuditSeverity.INFO,
          details: {
            deviceName: existingDevice.name || 'Unknown',
            wasOfflineAt: existingDevice.modified_at,
            offlineDurationMinutes: offlineDurationMin,
            cameOnlineAt: new Date().toISOString(),
          },
        });

        logger.info('Device came back online', {
          deviceName: existingDevice.name || uuid.substring(0, 8),
          deviceUuid: uuid,
          offlineDurationMinutes: offlineDurationMin,
          wasOfflineAt: existingDevice.modified_at,
          cameOnlineAt: new Date().toISOString(),
        });
      }
    }

    return result.rows[0];
  }

  static async getByUuid(uuid: string): Promise<Agent | null> {
    const result = await query<Agent>('SELECT * FROM agents WHERE uuid = $1', [uuid]);
    return result.rows[0] || null;
  }

  static async list(filters: { isOnline?: boolean; isActive?: boolean } = {}): Promise<Agent[]> {
    let sql = 'SELECT * FROM agents WHERE 1=1';
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

    const result = await query<Agent>(sql, params);
    return result.rows;
  }

  static async update(uuid: string, data: Partial<Agent>): Promise<Agent> {
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

    const result = await query<Agent>(
      `UPDATE agents SET ${fields.join(', ')} WHERE uuid = $${paramIndex} RETURNING *`,
      values
    );

    return result.rows[0];
  }

  static async upsert(uuid: string, data: Partial<Agent>): Promise<Agent> {
    const insertFields: string[] = ['uuid'];
    const insertPlaceholders: string[] = ['$1'];
    const updateFields: string[] = [];
    const values: any[] = [uuid];
    let paramIndex = 2;

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && key !== 'uuid' && key !== 'id') {
        insertFields.push(key);
        insertPlaceholders.push(`$${paramIndex}`);
        updateFields.push(`${key} = EXCLUDED.${key}`);
        values.push(value);
        paramIndex++;
      }
    });

    console.log('[DeviceModel.upsert] About to upsert device:', {
      uuid: uuid.substring(0, 8) + '...',
      insertFields,
      type: data.type,
      is_online: data.is_online,
      status: data.status,
      deployment_status: data.deployment_status,
      provisioning_state: data.provisioning_state,
    });

    const result = await query<Agent>(
      `INSERT INTO agents (${insertFields.join(', ')})
       VALUES (${insertPlaceholders.join(', ')})
       ON CONFLICT (uuid) DO UPDATE SET
         ${updateFields.join(', ')}
       RETURNING *`,
      values
    );

    console.log('[DeviceModel.upsert] Device upserted, returned values:', {
      uuid: result.rows[0].uuid.substring(0, 8) + '...',
      id: result.rows[0].id,
      is_online: result.rows[0].is_online,
      status: result.rows[0].status,
      deployment_status: result.rows[0].deployment_status,
      provisioning_state: result.rows[0].provisioning_state,
    });

    return result.rows[0];
  }

  static async markOffline(uuid: string): Promise<void> {
    await query('UPDATE agents SET is_online = false WHERE uuid = $1', [uuid]);
  }

  static async delete(uuid: string): Promise<void> {
    await query('DELETE FROM agents WHERE uuid = $1', [uuid]);
  }

  static async storeChallenge(uuid: string, challenge: string, expiresAt: Date): Promise<void> {
    await query(
      `UPDATE agents
       SET last_challenge = $1, last_challenge_expires_at = $2
       WHERE uuid = $3`,
      [challenge, expiresAt, uuid]
    );
  }

  static async markPopVerified(uuid: string): Promise<void> {
    await query(
      `UPDATE agents
       SET pop_verified = true,
           pop_verified_at = CURRENT_TIMESTAMP,
           last_challenge = NULL,
           last_challenge_expires_at = NULL
       WHERE uuid = $1`,
      [uuid]
    );
  }

  static async recordAuthMethod(uuid: string, method: 'pop' | 'bcrypt'): Promise<void> {
    await query(
      `UPDATE agents
       SET last_auth_method = $1,
           last_auth_at = CURRENT_TIMESTAMP
       WHERE uuid = $2`,
      [method, uuid]
    );
  }

  static async getPublicKey(uuid: string): Promise<string | null> {
    const result = await query<{ device_public_key: string }>(
      'SELECT device_public_key FROM agents WHERE uuid = $1',
      [uuid]
    );
    return result.rows[0]?.device_public_key || null;
  }

  static async setPublicKey(uuid: string, publicKey: string): Promise<void> {
    const result = await query(
      `UPDATE agents
       SET device_public_key = $1
       WHERE uuid = $2 AND device_public_key IS NULL`,
      [publicKey, uuid]
    );

    if (result.rowCount === 0) {
      throw new Error('Public key already set - cannot update (requires reprovisioning)');
    }
  }
}

// ============================================================================
// AgentTargetStateModel
// ============================================================================

export class AgentTargetStateModel {
  static async get(deviceUuid: string): Promise<AgentTargetState | null> {
    const result = await query<AgentTargetState>(
      'SELECT * FROM agent_target_state WHERE agent_uuid = $1',
      [deviceUuid]
    );
    return result.rows[0] || null;
  }

  static async set(
    deviceUuid: string,
    apps: any,
    config: any = {},
    needsDeployment: boolean = false
  ): Promise<AgentTargetState> {
    const device = await AgentModel.getOrCreate(deviceUuid);
    if (!device) {
      throw new Error(`Device ${deviceUuid} not found - cannot set target state`);
    }

    const result = await query<AgentTargetState>(
      `INSERT INTO agent_target_state (agent_uuid, apps, config, version, needs_deployment, updated_at)
       VALUES ($1, $2, $3, 1, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (agent_uuid) DO UPDATE SET
         apps = $2,
         config = $3,
         needs_deployment = $4,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [deviceUuid, JSON.stringify(apps), JSON.stringify(config), needsDeployment]
    );

    return result.rows[0];
  }

  static async deploy(
    deviceUuid: string,
    deployedBy: string = 'system'
  ): Promise<AgentTargetState> {
    const result = await query<AgentTargetState>(
      `UPDATE agent_target_state SET
         version = version + 1,
         needs_deployment = false,
         last_deployed_at = CURRENT_TIMESTAMP,
         deployed_by = $2,
         updated_at = CURRENT_TIMESTAMP
       WHERE agent_uuid = $1
       RETURNING *`,
      [deviceUuid, deployedBy]
    );

    if (result.rows.length === 0) {
      throw new Error(`Device ${deviceUuid} has no target state to deploy`);
    }

    const deployedState = result.rows[0];

    if (deployedState.config?.endpoints) {
      // Lazy import to avoid circular dependency with devices.ts
      const { AgentDeviceSyncService } = await import('./devices');
      const syncService = new AgentDeviceSyncService();
      const existingSensors = await query(
        'SELECT uuid, name FROM endpoints WHERE agent_uuid = $1',
        [deviceUuid]
      );
      const existingUuids = new Set(
        existingSensors.rows.map((row: any) => row.uuid).filter(Boolean)
      );
      const existingNames = new Set(existingSensors.rows.map((row: any) => row.name));

      const newEndpoints = deployedState.config.endpoints.filter((endpoint: any) => {
        if (endpoint.uuid && existingUuids.has(endpoint.uuid)) return false;
        if (endpoint.name && existingNames.has(endpoint.name)) return false;
        return true;
      });

      if (newEndpoints.length > 0) {
        await syncService.syncConfigToTable(
          deviceUuid,
          newEndpoints,
          deployedState.version,
          deployedBy
        );
      }
    }

    return deployedState;
  }

  static async clear(deviceUuid: string): Promise<void> {
    await query(
      `UPDATE agent_target_state SET apps = '{}', config = '{}', updated_at = CURRENT_TIMESTAMP
       WHERE agent_uuid = $1`,
      [deviceUuid]
    );
  }

  static generateETag(state: AgentTargetState): string {
    const payload = JSON.stringify({
      version: state.version,
      apps: state.apps,
      config: state.config,
    });
    return require('crypto').createHash('sha1').update(payload).digest('hex');
  }
}

// ============================================================================
// AgentCurrentStateModel
// ============================================================================

export class AgentCurrentStateModel {
  static async get(deviceUuid: string): Promise<AgentCurrentState | null> {
    const result = await query<AgentCurrentState>(
      'SELECT * FROM agent_current_state WHERE agent_uuid = $1',
      [deviceUuid]
    );
    return result.rows[0] || null;
  }

  static async update(
    deviceUuid: string,
    apps: any,
    config?: any,
    systemInfo: any = {},
    version?: number
  ): Promise<AgentCurrentState> {
    const device = await AgentModel.getOrCreate(deviceUuid);
    if (!device) {
      throw new Error(`Device ${deviceUuid} not found - cannot update current state`);
    }

    const configJson = config !== undefined && config !== null ? JSON.stringify(config) : null;

    const result = await query<AgentCurrentState>(
      `INSERT INTO agent_current_state (agent_uuid, apps, config, system_info, version, reported_at)
       VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), $4, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (agent_uuid) DO UPDATE SET
         apps = $2,
         config = CASE WHEN $3 IS NOT NULL THEN $3::jsonb ELSE agent_current_state.config END,
         system_info = $4,
         version = $5,
         reported_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [deviceUuid, JSON.stringify(apps), configJson, JSON.stringify(systemInfo), version || 0]
    );

    return result.rows[0];
  }
}

// ============================================================================
// AgentMetricsModel
// ============================================================================

export class AgentMetricsModel {
  static async getRecent(deviceUuid: string, limit: number = 100): Promise<AgentMetrics[]> {
    const result = await query<AgentMetrics>(
      `SELECT * FROM agent_metrics
       WHERE agent_uuid = $1
       ORDER BY recorded_at DESC
       LIMIT $2`,
      [deviceUuid, limit]
    );
    return result.rows;
  }

  static async getRecentByTime(
    deviceUuid: string,
    sinceTimestamp: string
  ): Promise<AgentMetrics[]> {
    const result = await query<AgentMetrics>(
      `SELECT * FROM agent_metrics
       WHERE agent_uuid = $1
       AND recorded_at >= $2
       ORDER BY recorded_at ASC`,
      [deviceUuid, sinceTimestamp]
    );
    return result.rows;
  }

  static async getByTimeRangeMinutes(
    deviceUuid: string,
    minutes: number,
    maxPoints: number = 60
  ): Promise<AgentMetrics[]> {
    let tableName: string;
    let timeColumn: string;
    let cpuUsageColumn: string;
    let memoryUsageColumn: string;
    let storageUsageColumn: string;
    let cpuTempColumn: string;

    if (minutes <= 30) {
      tableName = 'agent_metrics';
      timeColumn = 'recorded_at';
      cpuUsageColumn = 'cpu_usage';
      memoryUsageColumn = 'memory_usage';
      storageUsageColumn = 'storage_usage';
      cpuTempColumn = 'cpu_temp';
    } else if (minutes <= 360) {
      tableName = 'agent_metrics_5min';
      timeColumn = 'bucket';
      cpuUsageColumn = 'avg_cpu_usage';
      memoryUsageColumn = 'avg_memory_usage';
      storageUsageColumn = 'avg_storage_usage';
      cpuTempColumn = 'avg_cpu_temp';
    } else {
      tableName = 'agent_metrics_hourly';
      timeColumn = 'bucket';
      cpuUsageColumn = 'avg_cpu_usage';
      memoryUsageColumn = 'avg_memory_usage';
      storageUsageColumn = 'avg_storage_usage';
      cpuTempColumn = 'avg_cpu_temp';
    }

    let interval: number;
    if (tableName === 'agent_metrics_hourly') {
      interval = 1;
    } else {
      interval = Math.max(1, Math.ceil(minutes / maxPoints));
    }

    const result = await query<AgentMetrics>(
      `WITH numbered AS (
        SELECT
          agent_uuid,
          ${timeColumn} as recorded_at,
          ${cpuUsageColumn} as cpu_usage,
          ${memoryUsageColumn} as memory_usage,
          ${storageUsageColumn} as storage_usage,
          ${cpuTempColumn} as cpu_temperature,
          ROW_NUMBER() OVER (ORDER BY ${timeColumn}) as rn
        FROM ${tableName}
        WHERE agent_uuid = $1
          AND ${timeColumn} >= NOW() - INTERVAL '1 minute' * $2
          AND ${timeColumn} <= NOW()
      )
      SELECT
        agent_uuid,
        recorded_at,
        ROUND(cpu_usage::numeric, 1) as cpu_usage,
        ROUND(memory_usage::numeric, 0) as memory_usage,
        ROUND(storage_usage::numeric, 0) as storage_usage,
        ROUND(cpu_temperature::numeric, 1) as cpu_temperature
      FROM numbered
      WHERE ($3 = 1 OR rn % $3 = 1)
      ORDER BY recorded_at ASC`,
      [deviceUuid, minutes, interval]
    );

    return result.rows;
  }

  static async getByTimeRange(
    deviceUuid: string,
    startTime: Date,
    endTime: Date,
    maxPoints: number = 60
  ): Promise<AgentMetrics[]> {
    const totalMinutes = Math.floor((endTime.getTime() - startTime.getTime()) / 60000);
    const interval = Math.max(1, Math.floor(totalMinutes / maxPoints));

    let tableName: string;
    let timeColumn: string;
    let cpuUsageColumn: string;
    let memoryUsageColumn: string;
    let storageUsageColumn: string;
    let cpuTempColumn: string;

    if (totalMinutes <= 30) {
      tableName = 'agent_metrics';
      timeColumn = 'recorded_at';
      cpuUsageColumn = 'cpu_usage';
      memoryUsageColumn = 'memory_usage';
      storageUsageColumn = 'storage_usage';
      cpuTempColumn = 'cpu_temp';
    } else if (totalMinutes <= 360) {
      tableName = 'agent_metrics_5min';
      timeColumn = 'bucket';
      cpuUsageColumn = 'avg_cpu_usage';
      memoryUsageColumn = 'avg_memory_usage';
      storageUsageColumn = 'avg_storage_usage';
      cpuTempColumn = 'avg_cpu_temp';
    } else {
      tableName = 'agent_metrics_hourly';
      timeColumn = 'bucket';
      cpuUsageColumn = 'avg_cpu_usage';
      memoryUsageColumn = 'avg_memory_usage';
      storageUsageColumn = 'avg_storage_usage';
      cpuTempColumn = 'avg_cpu_temp';
    }

    const result = await query<AgentMetrics>(
      `WITH numbered AS (
        SELECT
          agent_uuid,
          ${timeColumn} as recorded_at,
          ${cpuUsageColumn} as cpu_usage,
          ${memoryUsageColumn} as memory_usage,
          ${storageUsageColumn} as storage_usage,
          ${cpuTempColumn} as cpu_temperature,
          ROW_NUMBER() OVER (ORDER BY ${timeColumn}) as rn
        FROM ${tableName}
        WHERE agent_uuid = $1
          AND ${timeColumn} >= ($2::timestamptz AT TIME ZONE 'UTC')::timestamp
          AND ${timeColumn} <= ($3::timestamptz AT TIME ZONE 'UTC')::timestamp
      )
      SELECT
        agent_uuid,
        recorded_at,
        cpu_usage,
        memory_usage,
        storage_usage,
        cpu_temperature
      FROM numbered
      WHERE rn % $4 = 1
      ORDER BY recorded_at ASC`,
      [deviceUuid, startTime.toISOString(), endTime.toISOString(), interval]
    );

    return result.rows;
  }

  static async cleanup(_daysToKeep?: number): Promise<number> {
    return 0;
  }
}

// ============================================================================
// AgentLogsModel
// ============================================================================

export class AgentLogsModel {
  static async store(
    deviceUuid: string,
    logs: Array<{
      serviceName?: string;
      timestamp?: Date;
      message: string;
      level?: string;
      isSystem?: boolean;
      isStderr?: boolean;
      meta?: Record<string, any> | null;
    }>,
    batchSize: number = 500
  ): Promise<void> {
    if (logs.length === 0) return;

    const batches: typeof logs[] = [];
    for (let i = 0; i < logs.length; i += batchSize) {
      batches.push(logs.slice(i, i + batchSize));
    }

    await Promise.all(
      batches.map(async (batch) => {
        const values: any[] = [];
        const placeholders: string[] = [];

        batch.forEach((log, index) => {
          const offset = index * 8;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`
          );
          values.push(
            deviceUuid,
            log.serviceName || null,
            log.timestamp || new Date(),
            log.message,
            log.level || 'info',
            log.isSystem || false,
            log.isStderr || false,
            log.meta ? JSON.stringify(log.meta) : null
          );
        });

        await query(
          `INSERT INTO agent_logs (agent_uuid, service_name, timestamp, message, level, is_system, is_stderr, meta)
           VALUES ${placeholders.join(', ')}`,
          values
        );
      })
    );
  }

  static async get(
    deviceUuid: string,
    options: {
      serviceName?: string;
      limit?: number;
      offset?: number;
      since?: Date;
    } = {}
  ): Promise<any[]> {
    let sql = 'SELECT * FROM agent_logs WHERE agent_uuid = $1';
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

  static async cleanup(daysToKeep: number = 7): Promise<number> {
    const result = await query(
      `DELETE FROM agent_logs
       WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'`
    );
    return result.rowCount || 0;
  }
}

const log = logger.child({ module: 'agents-service' });
const eventPublisher = new EventPublisher();

// ============================================================================
// Shared Types
// ============================================================================

export interface ActorInfo {
  userId?: string;
  userEmail?: string;
  ip?: string;
  userAgent?: string;
}

export interface ServiceInput {
  serviceName: string;
  image: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  config?: Record<string, unknown>;
  state?: string;
}

export interface TagInput {
  key: string;
  value: string;
}

// ============================================================================
// Locations
// ============================================================================

export async function getLocations(): Promise<string[]> {
  const result = await query(`
    SELECT DISTINCT location
    FROM (
      SELECT location FROM agents WHERE location IS NOT NULL AND location != ''
      UNION
      SELECT extra->>'location' as location FROM readings
      WHERE extra->>'location' IS NOT NULL AND extra->>'location' != ''
      AND time > NOW() - INTERVAL '30 days'
    ) locations
    ORDER BY location
  `);
  return result.rows.map((row: { location: string }) => row.location);
}

// ============================================================================
// List / Get Agents
// ============================================================================

export interface ListAgentsParams {
  isOnline?: boolean;
  page: number;
  limit: number;
  filter: string;
  includeTags: boolean;
}

export async function listAgents(params: ListAgentsParams) {
  const { isOnline, page, limit, filter, includeTags } = params;

  const agents = await AgentModel.list({ isOnline });

  let filteredDevices = agents;
  if (filter === 'active') {
    filteredDevices = agents.filter((d: { is_online: boolean }) => d.is_online === true);
  } else if (filter === 'inactive') {
    filteredDevices = agents.filter((d: { is_online: boolean }) => d.is_online === false);
  }

  const totalDevices = filteredDevices.length;
  const totalPages = Math.ceil(totalDevices / limit);
  const offset = (page - 1) * limit;
  const paginatedDevices = filteredDevices.slice(offset, offset + limit);

  const enhancedDevices = await Promise.all(
    (paginatedDevices as unknown as Record<string, unknown>[]).map(async (device) => {
      const targetState = await AgentTargetStateModel.get(device.uuid as string);
      const currentState = await AgentCurrentStateModel.get(device.uuid as string);
      let systemInfo = currentState?.system_info;

      if (typeof systemInfo === 'string') {
        try {
          systemInfo = JSON.parse(systemInfo);
        } catch {
          systemInfo = null;
        }
      }

      return {
        id: device.uuid,
        uuid: device.uuid,
        name: device.name,
        device_name: device.name,
        device_type: device.type,
        location: device.location,
        state: device.is_online ? 'active' : 'inactive',
        provisioning_state: device.provisioning_state,
        status: device.status,
        is_online: device.is_online,
        lastSeen: device.last_connectivity_event,
        last_connectivity_event: device.last_connectivity_event,
        ip_address: device.ip_address,
        mac_address: device.mac_address,
        os_version: device.os_version,
        architecture: (systemInfo as Record<string, unknown> | null)?.architecture || null,
        agent_version: device.agent_version,
        cpu_usage: device.cpu_usage,
        cpu_temp: device.cpu_temp,
        memory_usage: device.memory_usage,
        memory_total: device.memory_total,
        storage_usage: device.storage_usage,
        storage_total: device.storage_total,
        target_apps_count: targetState ? Object.keys(targetState.apps || {}).length : 0,
        current_apps_count: currentState ? Object.keys(currentState.apps || {}).length : 0,
        last_reported: currentState?.reported_at,
        created_at: device.created_at,
        fleet_uuid: device.fleet_uuid || null,
        metrics: {
          cpu: device.cpu_usage,
          memory: device.memory_usage,
          io: Math.floor(Math.random() * 70 + 10),
          pw: Math.floor(Math.random() * 70 + 10),
        },
      };
    })
  );

  let agentsWithTags = enhancedDevices;
  if (includeTags && enhancedDevices.length > 0) {
    const deviceUuids = enhancedDevices.map((device) => device.uuid);
    const tagsResult = await query(
      'SELECT agent_uuid, key, value FROM agent_tags WHERE agent_uuid = ANY($1::uuid[])',
      [deviceUuids]
    );

    const tagsByDevice: Record<string, Record<string, string>> = {};
    tagsResult.rows.forEach((row: { agent_uuid: string; key: string; value: string }) => {
      if (!tagsByDevice[row.agent_uuid]) {
        tagsByDevice[row.agent_uuid] = {};
      }
      tagsByDevice[row.agent_uuid][row.key] = row.value;
    });

    agentsWithTags = enhancedDevices.map((device) => ({
      ...device,
      tags: tagsByDevice[device.uuid as string] || {},
    }));
  }

  return {
    agents: agentsWithTags,
    pagination: { page, limit, totalDevices, totalPages },
  };
}

export async function getAgent(uuid: string) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return null;

  const targetState = await AgentTargetStateModel.get(uuid);
  const currentState = await AgentCurrentStateModel.get(uuid);

  return {
    device,
    target_state: targetState
      ? {
          apps:
            typeof targetState.apps === 'string'
              ? JSON.parse(targetState.apps as unknown as string)
              : targetState.apps,
          config:
            typeof targetState.config === 'string'
              ? JSON.parse(targetState.config as unknown as string)
              : targetState.config,
          version: targetState.version,
          needs_deployment: targetState.needs_deployment || false,
          last_deployed_at: targetState.last_deployed_at || null,
          deployed_by: targetState.deployed_by || null,
          updated_at: targetState.updated_at,
        }
      : { apps: {}, config: {}, version: 1, needs_deployment: false },
    current_state: currentState
      ? {
          apps:
            typeof currentState.apps === 'string'
              ? JSON.parse(currentState.apps as unknown as string)
              : currentState.apps,
          config:
            typeof currentState.config === 'string'
              ? JSON.parse(currentState.config as unknown as string)
              : currentState.config,
          version: currentState.version || 0,
          system_info:
            typeof currentState.system_info === 'string'
              ? JSON.parse(currentState.system_info as unknown as string)
              : currentState.system_info,
          reported_at: currentState.reported_at,
        }
      : null,
  };
}

// ============================================================================
// Update / Activate / Delete
// ============================================================================

export interface AgentUpdateFields {
  deviceName?: string;
  deviceType?: string;
  ipAddress?: string;
  macAddress?: string;
  location?: string | null;
}

export async function updateAgent(uuid: string, fields: AgentUpdateFields) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return null;

  const updateFields: Record<string, unknown> = {};
  if (fields.deviceName) updateFields['name'] = fields.deviceName;
  if (fields.deviceType) updateFields['type'] = fields.deviceType;
  if (fields.ipAddress) updateFields['ip_address'] = fields.ipAddress;
  if (fields.macAddress) updateFields['mac_address'] = fields.macAddress;
  if (fields.location !== undefined) updateFields['location'] = fields.location || null;
  updateFields['modified_at'] = new Date();

  const updatedDevice = await AgentModel.update(uuid, updateFields);

  await logAuditEvent({
    eventType: AuditEventType.DEVICE_CONFIG_UPDATE,
    agentUuid: uuid,
    severity: AuditSeverity.INFO,
    details: {
      updatedFields: Object.keys(updateFields),
      ...fields,
    },
  });

  return {
    uuid: updatedDevice.uuid,
    deviceName: updatedDevice.name,
    deviceType: updatedDevice.type,
    ipAddress: updatedDevice.ip_address,
    macAddress: updatedDevice.mac_address,
    location: updatedDevice.location,
    isOnline: updatedDevice.is_online,
    isActive: updatedDevice.is_active,
    modifiedAt: updatedDevice.modified_at,
  };
}

export async function setAgentActive(uuid: string, isActive: boolean, actor: ActorInfo) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return null;

  const updatedDevice = await AgentModel.update(uuid, { is_active: isActive });

  const action = isActive ? 'enabled' : 'disabled';
  log.info(`Device ${action}`, {
    deviceId: uuid.substring(0, 8),
    deviceName: device.name,
    isActive,
  });

  await eventPublisher.publish(
    isActive ? 'device.online' : 'device.offline',
    'agent',
    uuid,
    {
      device_name: device.name,
      device_type: device.type,
      previous_state: device.is_active,
      new_state: isActive,
      reason: isActive ? 'administratively enabled' : 'administratively disabled',
      changed_at: new Date().toISOString(),
    },
    {
      metadata: {
        request: {
          method: 'PATCH',
          path: '/agents/:uuid/active',
          user_agent: actor.userAgent,
        },
      },
      severity: 'info',
      impact: 'medium',
      actor: {
        type: 'user',
        id: actor.userId ?? 'system',
        name: actor.userEmail,
        ip_address: actor.ip,
      },
    }
  );

  await logAuditEvent({
    eventType: isActive ? AuditEventType.DEVICE_REGISTERED : AuditEventType.DEVICE_OFFLINE,
    agentUuid: uuid,
    severity: AuditSeverity.INFO,
    details: {
      action: `device_${action}`,
      deviceName: device.name,
      previousState: device.is_active,
      newState: isActive,
    },
  });

  return {
    uuid: updatedDevice.uuid,
    device_name: updatedDevice.name,
    is_active: updatedDevice.is_active,
    is_online: updatedDevice.is_online,
  };
}

export async function deleteAgent(uuid: string) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return null;
  await AgentModel.delete(uuid);
  return device;
}

// ============================================================================
// Register Agent
// ============================================================================

export interface RegisterAgentParams {
  deviceName: string;
  deviceType?: string;
  ipAddress?: string;
  macAddress?: string;
  namespace?: string;
  fleet_uuid?: string;
  tags?: TagInput[];
  metadata?: unknown;
  endpoints?: unknown;
}

export async function registerAgent(params: RegisterAgentParams, actor: ActorInfo) {
  const {
    deviceName,
    deviceType,
    ipAddress,
    macAddress,
    namespace,
    fleet_uuid,
    tags,
    metadata,
    endpoints,
  } = params;

  const deviceUuid = randomUUID();
  const uniqueDeviceName = `${deviceName}-${deviceUuid.slice(0, 8)}`;
  const type = deviceType || 'gateway';
  const isVirtual = type === 'virtual';

  // ===== VIRTUAL AGENT PATH =====
  if (isVirtual) {
    let targetNamespace = namespace || process.env.VIRTUAL_AGENT_NAMESPACE || 'virtual-agents';

    if (fleet_uuid) {
      const fleetResult = await query(
        'SELECT k8s_namespace FROM fleets WHERE fleet_uuid = $1',
        [fleet_uuid]
      );

      if (fleetResult.rows.length > 0 && fleetResult.rows[0].k8s_namespace) {
        targetNamespace = fleetResult.rows[0].k8s_namespace;
        log.info('Using fleet namespace for virtual agent deployment', {
          fleet_uuid,
          namespace: targetNamespace,
        });
      } else if (fleetResult.rows.length === 0) {
        return { error: 'fleet_not_found', fleet_uuid };
      } else {
        log.warn('Fleet has no k8s_namespace, using default', {
          fleet_uuid,
          defaultNamespace: targetNamespace,
        });
      }
    }

    log.info('Creating virtual agent via unified endpoint', {
      deviceUuid: deviceUuid.substring(0, 8) + '...',
      deviceName: uniqueDeviceName,
      originalName: deviceName,
      namespace: targetNamespace,
      fleet_uuid: fleet_uuid || 'auto',
    });

    const deviceApiKey = randomBytes(32).toString('hex');

    await provisioningService.registerDevice(
      {
        uuid: deviceUuid,
        agentName: uniqueDeviceName,
        agentType: 'virtual',
        agentApiKey: deviceApiKey,
        provisioningApiKey: 'virtual-agent-auto-generated',
        namespace: targetNamespace,
        fleet_uuid: fleet_uuid || undefined,
        metadata,
        endpoints: endpoints as Array<{ protocol: string; [key: string]: unknown }> | undefined,
      },
      actor.ip,
      actor.userAgent
    );

    if (tags && Array.isArray(tags) && tags.length > 0) {
      for (const tag of tags) {
        await query(
          `INSERT INTO agent_tags (agent_uuid, tag_key, tag_value)
           VALUES ($1, $2, $3)
           ON CONFLICT (agent_uuid, tag_key) DO UPDATE SET tag_value = EXCLUDED.tag_value`,
          [deviceUuid, tag.key, tag.value]
        );
      }
    }

    return {
      virtual: true,
      deviceUuid,
      deviceName: uniqueDeviceName,
      originalName: deviceName,
      deviceType: 'virtual',
      namespace: targetNamespace,
    };
  }

  // ===== PHYSICAL DEVICE PATH =====
  const result = await query(
    `INSERT INTO agents (
      uuid,
      name,
      type,
      ip_address,
      mac_address,
      fleet_uuid,
      is_online,
      is_active,
      provisioning_state,
      created_at,
      modified_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    RETURNING *`,
    [
      deviceUuid,
      uniqueDeviceName,
      type,
      ipAddress || null,
      macAddress || null,
      null,
      false,
      false,
      'pending',
    ]
  );

  const device = result.rows[0];

  await query(
    `INSERT INTO agent_target_state (
      agent_uuid,
      apps,
      config,
      version,
      needs_deployment,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [deviceUuid, JSON.stringify({}), JSON.stringify({}), 1, false]
  );

  await logAuditEvent({
    eventType: AuditEventType.DEVICE_REGISTERED,
    severity: AuditSeverity.INFO,
    agentUuid: deviceUuid,
    details: {
      deviceName: uniqueDeviceName,
      originalName: deviceName,
      deviceType: type,
      ipAddress,
      macAddress,
      action: 'pre-registered',
    },
  });

  log.info('Device pre-registered', {
    deviceName: uniqueDeviceName,
    originalName: deviceName,
    deviceId: deviceUuid,
    deviceType: type,
  });

  return {
    virtual: false,
    device: {
      uuid: device.uuid,
      deviceName: device.name,
      deviceType: device.type,
      ipAddress: device.ip_address,
      macAddress: device.mac_address,
      isOnline: device.is_online,
      isActive: device.is_active,
      createdAt: device.created_at,
    },
  };
}

// ============================================================================
// Virtual Agent (dedicated endpoint)
// ============================================================================

export interface CreateVirtualAgentParams {
  deviceName: string;
  fleetId?: string;
  namespace?: string;
  tags?: TagInput[];
}

export async function createVirtualAgent(params: CreateVirtualAgentParams, actor: ActorInfo) {
  const { deviceName, fleetId, namespace, tags } = params;

  const deviceUuid = randomUUID();
  const deviceApiKey = randomBytes(32).toString('hex');
  let targetNamespace = namespace || process.env.VIRTUAL_AGENT_NAMESPACE || 'virtual-agents';

  if (fleetId) {
    const fleetResult = await query(
      'SELECT k8s_namespace FROM fleets WHERE fleet_uuid = $1',
      [fleetId]
    );

    if (fleetResult.rows.length > 0 && fleetResult.rows[0].k8s_namespace) {
      targetNamespace = fleetResult.rows[0].k8s_namespace;
      log.info('Using fleet namespace for virtual agent deployment', {
        fleetId,
        namespace: targetNamespace,
      });
    } else if (fleetResult.rows.length === 0) {
      return { error: 'fleet_not_found', fleetId };
    } else {
      log.warn('Fleet has no k8s_namespace, using default', {
        fleetId,
        defaultNamespace: targetNamespace,
      });
    }
  }

  log.info('Creating virtual agent', {
    deviceUuid: deviceUuid.substring(0, 8) + '...',
    deviceName,
    fleetId,
    namespace: targetNamespace,
  });

  await provisioningService.registerDevice(
    {
      uuid: deviceUuid,
      agentName: deviceName,
      agentType: 'virtual',
      agentApiKey: deviceApiKey,
      provisioningApiKey: 'virtual-agent-auto-generated',
      namespace: targetNamespace,
      fleet_uuid: fleetId || undefined,
    },
    actor.ip,
    actor.userAgent
  );

  if (tags && Array.isArray(tags) && tags.length > 0) {
    for (const tag of tags) {
      await query(
        `INSERT INTO agent_tags (agent_uuid, tag_key, tag_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_uuid, tag_key) DO UPDATE SET tag_value = EXCLUDED.tag_value`,
        [deviceUuid, tag.key, tag.value]
      );
    }
  }

  return { deviceUuid, deviceName, namespace: targetNamespace };
}

// ============================================================================
// App Deployment
// ============================================================================

export async function deployApp(
  uuid: string,
  appId: number,
  appName: string | undefined,
  services: ServiceInput[],
  userId: string
) {
  let appNameToUse = appName;
  const appResult = await query('SELECT * FROM applications WHERE id = $1', [appId]);

  if (appResult.rows.length > 0) {
    appNameToUse = appResult.rows[0].app_name;
  } else if (!appName) {
    return { error: 'app_not_found', appId };
  }

  const device = await AgentModel.getByUuid(uuid);
  if (!device) return { error: 'device_not_found', uuid };

  const currentTarget = await AgentTargetStateModel.get(uuid);
  const currentApps = currentTarget?.apps || {};

  const servicesWithIds = await Promise.all(
    services.map(async (service) => {
      const idResult = await query<{ nextval: number }>(
        "SELECT nextval('global_service_id_seq') as nextval"
      );
      const serviceId = idResult.rows[0].nextval;

      await query(
        `INSERT INTO app_service_ids (entity_type, entity_id, entity_name, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'service',
          serviceId,
          service.serviceName,
          JSON.stringify({ appId, appName: appNameToUse, imageName: service.image }),
          userId,
        ]
      );

      return {
        serviceId,
        serviceName: service.serviceName,
        imageName: service.image,
        config: {
          ...(service.ports && { ports: service.ports }),
          ...(service.environment && { environment: service.environment }),
          ...(service.volumes && { volumes: service.volumes }),
          ...(service.config || {}),
        },
      };
    })
  );

  const newApps = {
    ...currentApps,
    [appId]: { appId, appName: appNameToUse, services: servicesWithIds },
  };

  await AgentTargetStateModel.set(uuid, newApps, currentTarget?.config || {});

  log.info('App deployed to device', {
    deviceId: uuid.substring(0, 8),
    appId,
    appName: appNameToUse,
    serviceCount: servicesWithIds.length,
    services: servicesWithIds.map((s) => s.serviceName),
  });

  return { appId, appName: appNameToUse, services: servicesWithIds };
}

export async function updateApp(
  uuid: string,
  appId: number,
  appName: string | undefined,
  services: ServiceInput[]
) {
  const currentTarget = await AgentTargetStateModel.get(uuid);
  if (!currentTarget) return { error: 'no_target_state' };

  const currentApps = currentTarget.apps || {};
  if (!currentApps[appId]) return { error: 'app_not_found', appId };

  const existingServices = currentApps[appId].services || [];

  const servicesWithIds = await Promise.all(
    services.map(async (service) => {
      const existingService = existingServices.find(
        (s: { serviceName: string; serviceId: number }) => s.serviceName === service.serviceName
      );

      let serviceId: number;
      if (existingService?.serviceId) {
        serviceId = existingService.serviceId;
      } else {
        const idResult = await query<{ nextval: number }>(
          "SELECT nextval('global_service_id_seq') as nextval"
        );
        serviceId = idResult.rows[0].nextval;
      }

      return {
        serviceId,
        serviceName: service.serviceName,
        imageName: service.image,
        ...(service.state && { state: service.state }),
        config: {
          ...(service.ports && { ports: service.ports }),
          ...(service.environment && { environment: service.environment }),
          ...(service.volumes && { volumes: service.volumes }),
          ...(service.config || {}),
        },
      };
    })
  );

  currentApps[appId].services = servicesWithIds;
  if (appName) currentApps[appId].appName = appName;

  await AgentTargetStateModel.set(uuid, currentApps, currentTarget.config || {});

  log.info('App updated on device', {
    deviceId: uuid.substring(0, 8),
    appId,
    appName: currentApps[appId].appName,
    serviceCount: servicesWithIds.length,
  });

  return { appId, appName: currentApps[appId].appName, services: servicesWithIds };
}

export async function removeApp(uuid: string, appId: number) {
  const currentTarget = await AgentTargetStateModel.get(uuid);
  if (!currentTarget) return { error: 'no_target_state' };

  const currentApps = currentTarget.apps || {};
  if (!currentApps[appId]) return { error: 'app_not_found', appId };

  const appName = currentApps[appId].appName;
  delete currentApps[appId];

  await AgentTargetStateModel.set(uuid, currentApps, currentTarget.config || {});

  log.info('App removed from device', {
    deviceId: uuid.substring(0, 8),
    appId,
    appName,
  });

  return { appId, appName };
}

export async function deployAppVersion(uuid: string, appId: number, deployedBy: string) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return { error: 'device_not_found' };

  const currentTarget = await AgentTargetStateModel.get(uuid);
  if (!currentTarget) return { error: 'no_target_state' };

  const currentApps = currentTarget.apps || {};
  if (!currentApps[appId]) return { error: 'app_not_found', appId };

  const appName = currentApps[appId].appName;
  const deployedState = await AgentTargetStateModel.deploy(uuid, deployedBy);

  await logAuditEvent({
    eventType: AuditEventType.DEVICE_CONFIG_UPDATE,
    agentUuid: uuid,
    severity: AuditSeverity.INFO,
    details: { action: 'deploy_app', appId, appName, version: deployedState.version, deployedBy },
  });

  log.info('App deployed successfully', {
    deviceId: uuid.substring(0, 8),
    appId,
    appName,
    version: deployedState.version,
    deployedBy,
  });

  return {
    version: deployedState.version,
    appId,
    appName,
    deployedBy: deployedState.deployed_by,
  };
}

// ============================================================================
// Target State Deployment
// ============================================================================

export async function deployTargetState(uuid: string, deployedBy: string) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return { error: 'device_not_found' };

  const currentTarget = await AgentTargetStateModel.get(uuid);
  if (!currentTarget) return { error: 'no_target_state' };

  if (!currentTarget.needs_deployment) {
    return { error: 'nothing_to_deploy', version: currentTarget.version };
  }

  const deployedState = await AgentTargetStateModel.deploy(uuid, deployedBy);

  await logAuditEvent({
    eventType: AuditEventType.DEVICE_CONFIG_UPDATE,
    agentUuid: uuid,
    severity: AuditSeverity.INFO,
    details: {
      action: 'deploy',
      version: deployedState.version,
      deployedBy,
      appsCount: Object.keys(deployedState.apps || {}).length,
    },
  });

  log.info('Target state deployed successfully', {
    deviceId: uuid.substring(0, 8),
    version: deployedState.version,
    appsCount: Object.keys(deployedState.apps || {}).length,
    deployedBy,
  });

  return {
    version: deployedState.version,
    deployedBy,
    deployedAt: deployedState.last_deployed_at,
    appsCount: Object.keys(deployedState.apps || {}).length,
  };
}

export async function cancelDeployment(uuid: string) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return { error: 'device_not_found' };

  const currentTarget = await AgentTargetStateModel.get(uuid);
  if (!currentTarget) return { error: 'no_target_state' };

  if (!currentTarget.needs_deployment) {
    return { error: 'nothing_to_cancel', version: currentTarget.version };
  }

  const history = await query(
    `SELECT apps, config, version
     FROM agent_target_state_history
     WHERE agent_uuid = $1
     ORDER BY deployed_at DESC
     LIMIT 1`,
    [uuid]
  );

  if (history.rows.length === 0) {
    await query(
      'UPDATE agent_target_state SET needs_deployment = false WHERE agent_uuid = $1',
      [uuid]
    );
  } else {
    const lastDeployed = history.rows[0];
    await query(
      `UPDATE agent_target_state
       SET apps = $1,
           config = $2,
           needs_deployment = false
       WHERE agent_uuid = $3`,
      [lastDeployed.apps, lastDeployed.config, uuid]
    );
  }

  await logAuditEvent({
    eventType: AuditEventType.DEVICE_CONFIG_UPDATE,
    agentUuid: uuid,
    severity: AuditSeverity.INFO,
    details: {
      action: 'cancel_deployment',
      version: currentTarget.version,
      restoredFrom: history.rows.length > 0 ? 'history' : 'current',
    },
  });

  log.info('Pending deployment canceled', {
    deviceId: uuid.substring(0, 8),
    version: currentTarget.version,
  });

  return { version: currentTarget.version };
}

// ============================================================================
// Broker Assignment
// ============================================================================

export async function assignBroker(uuid: string, brokerId: number, actor: ActorInfo) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return { error: 'device_not_found' };

  const broker = await SystemConfig.getMqttBroker(brokerId);
  if (!broker) return { error: 'broker_not_found', brokerId };

  const brokerUrl = `${broker.protocol}://${broker.host}:${broker.port}`;

  await query(
    'UPDATE agents SET mqtt_broker_id = $1, modified_at = CURRENT_TIMESTAMP WHERE uuid = $2',
    [brokerId, uuid]
  );

  const brokerConfig = {
    brokerId: broker.id,
    brokerName: broker.name,
    broker: brokerUrl,
    protocol: broker.protocol,
    host: broker.host,
    port: broker.port,
    useTls: broker.use_tls,
    verifyCertificate: broker.verify_certificate,
    clientIdPrefix: broker.client_id_prefix || 'Iotistic',
    keepAlive: broker.keep_alive || 60,
    cleanSession: broker.clean_session !== false,
    reconnectPeriod: broker.reconnect_period || 1000,
    connectTimeout: broker.connect_timeout || 30000,
    ...(broker.ca_cert && { caCert: broker.ca_cert }),
    ...(broker.client_cert && { clientCert: broker.client_cert }),
  };

  const shadowResult = await query(
    `INSERT INTO agent_shadows (agent_uuid, desired, version)
     VALUES ($1, jsonb_build_object('mqtt', $2::jsonb), 1)
     ON CONFLICT (agent_uuid)
     DO UPDATE SET
       desired = jsonb_set(
         COALESCE(agent_shadows.desired, '{}'::jsonb),
         '{mqtt}',
         $2::jsonb
       ),
       version = agent_shadows.version + 1,
       updated_at = CURRENT_TIMESTAMP
     RETURNING version`,
    [uuid, JSON.stringify(brokerConfig)]
  );

  const version = shadowResult.rows[0].version;

  let mqttPublished = false;
  try {
    const { getMqttManager } = require('../../mqtt');
    const mqttManager = getMqttManager();

    if (mqttManager && mqttManager.isConnected()) {
      const tenantId = getTenantId();
      const shadowTopic = mqttDeviceTopic(tenantId, uuid, 'shadow', 'name', 'device-state', 'update', 'delta');
      await mqttManager.publish(
        shadowTopic,
        JSON.stringify({
          state: { mqtt: brokerConfig },
          metadata: { mqtt: { timestamp: Date.now() } },
          version,
          timestamp: Math.floor(Date.now() / 1000),
        }),
        { qos: 1 }
      );
      mqttPublished = true;
    }
  } catch (err) {
    log.warn('Could not publish shadow delta via MQTT', {
      deviceId: uuid.substring(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await logAuditEvent({
    eventType: 'device.config.updated' as Parameters<typeof logAuditEvent>[0]['eventType'],
    agentUuid: uuid,
    severity: AuditSeverity.INFO,
    details: {
      change: 'broker_assignment',
      newBrokerId: brokerId,
      brokerName: broker.name,
      brokerUrl,
      shadowVersion: version,
      mqttNotified: mqttPublished,
    },
  });

  return {
    device: { uuid: device.uuid, name: device.name },
    broker: { id: broker.id, name: broker.name, url: brokerUrl },
    shadow: { version, mqttPublished },
  };
}

// ============================================================================
// Agent Update Trigger
// ============================================================================

export interface TriggerUpdateParams {
  version?: string;
  scheduled_time?: string;
  force?: boolean;
}

/**
 * Sign an agent update command with HMAC-SHA256.
 * Uses the same canonical string format as the on-device verifyCommandSignature().
 */
export function signAgentUpdate(params: {
  version: string;
  issuedAt: number;
  expiresAt?: number;
  scheduledTime?: string;
  force?: boolean;
}): string | undefined {
  const secret = process.env.UPDATE_COMMAND_SECRET;
  if (!secret) return undefined;

  const { version, issuedAt, expiresAt, scheduledTime, force } = params;
  const canonicalString = [
    'update',
    version,
    issuedAt.toString(),
    expiresAt?.toString() || '',
    scheduledTime || '',
    force?.toString() || ''
  ].join('|');

  return createHmac('sha256', secret).update(canonicalString).digest('hex');
}

export async function triggerAgentUpdate(
  uuid: string,
  params: TriggerUpdateParams,
  actor: ActorInfo
) {
  const { version, scheduled_time, force = false } = params;

  const device = await AgentModel.getByUuid(uuid);
  if (!device) return { error: 'device_not_found' };

  const brokerConfig = await getDefaultBrokerConfig();
  if (!brokerConfig) return { error: 'broker_not_configured' };

  const brokerUrl = buildBrokerUrl(brokerConfig);
  const mqttUsername = brokerConfig.username || process.env.MQTT_USERNAME;
  const mqttPassword = process.env.MQTT_PASSWORD;

  log.info('Triggering agent update', {
    deviceUuid: uuid,
    version: version || 'latest',
    scheduled: !!scheduled_time,
    force,
    brokerSource: brokerConfig.id === 0 ? 'environment' : `database (${brokerConfig.name})`,
  });

  const mqttOptions: mqtt.IClientOptions = {
    username: mqttUsername,
    password: mqttPassword,
    clientId: `api-agent-update-${Date.now()}`,
    clean: true,
  };

  if (brokerUrl.startsWith('mqtts://')) {
    (mqttOptions as Record<string, unknown>).rejectUnauthorized =
      process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false';
  }

  const mqttClient = mqtt.connect(brokerUrl, mqttOptions);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      mqttClient.end();
      reject(new Error('MQTT connection timeout'));
    }, 5000);

    mqttClient.on('connect', () => {
      clearTimeout(timeout);
      resolve();
    });

    mqttClient.on('error', (err) => {
      clearTimeout(timeout);
      mqttClient.end();
      reject(err);
    });
  });

  const tenantId = getTenantId();
  const updateTopic = mqttDeviceTopic(tenantId, uuid, 'agent', 'update');
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 24 * 60 * 60 * 1000; // 24 hours
  const signature = signAgentUpdate({
    version: version || 'latest',
    issuedAt,
    expiresAt,
    scheduledTime: scheduled_time,
    force,
  });

  const updateCommand: Record<string, unknown> = {
    action: 'update',
    version: version || 'latest',
    scheduled_time,
    force,
    issued_at: issuedAt,
    expires_at: expiresAt,
    timestamp: issuedAt,
  };
  if (signature) updateCommand.signature = signature;

  await new Promise<void>((resolve, reject) => {
    mqttClient.publish(
      updateTopic,
      JSON.stringify(updateCommand),
      { qos: 1, retain: true },
      (err) => {
        mqttClient.end();
        if (err) reject(err);
        else resolve();
      }
    );
  });

  await logAuditEvent({
    eventType: 'device.agent.update.triggered' as Parameters<typeof logAuditEvent>[0]['eventType'],
    agentUuid: uuid,
    severity: AuditSeverity.INFO,
    details: { version: version || 'latest', scheduled_time, force, mqttTopic: updateTopic },
  });

  await eventPublisher.publish('device.agent.update.triggered', 'agent', uuid, {
    version: version || 'latest',
    scheduled_time,
    force,
  });

  return {
    device: { uuid: device.uuid, deviceName: device.name },
    update: { version: version || 'latest', scheduled: !!scheduled_time, scheduled_time, force, mqttTopic: updateTopic },
  };
}

// ============================================================================
// Virtual Agent Operations
// ============================================================================

export async function getDeploymentStatus(uuid: string) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return null;
  if (device.type !== 'virtual') return { error: 'not_virtual' };

  const deploymentStatus = await virtualAgentDeployer.getStatus(uuid);

  return {
    deviceUuid: uuid,
    deviceName: device.name,
    deploymentStatus: deploymentStatus.status,
    namespace: deploymentStatus.namespace,
    podName: deploymentStatus.podName,
    deploymentName: deploymentStatus.deploymentName,
    isOnline: device.is_online,
    deviceStatus: device.status,
    message: deploymentStatus.message,
    error: deploymentStatus.error,
  };
}

export async function destroyVirtualAgent(uuid: string) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return { error: 'device_not_found' };
  if (device.type !== 'virtual') return { error: 'not_virtual' };

  log.info('Destroying virtual agent (hard delete)', {
    deviceUuid: uuid.substring(0, 8) + '...',
    deviceName: device.name,
    namespace: device.k8s_namespace,
  });

  try {
    await virtualAgentDeployer.destroy(uuid);
    log.info('K8s resources destroyed', { deviceUuid: uuid.substring(0, 8) + '...' });
  } catch (k8sError: unknown) {
    log.warn('K8s cleanup partially failed (continuing with database deletion)', {
      error: k8sError instanceof Error ? k8sError.message : String(k8sError),
      deviceUuid: uuid.substring(0, 8) + '...',
    });
  }

  await AgentModel.delete(uuid);

  await logAuditEvent({
    eventType: 'device.deployment.destroyed' as Parameters<typeof logAuditEvent>[0]['eventType'],
    agentUuid: uuid,
    severity: AuditSeverity.INFO,
    details: { deviceName: device.name, namespace: device.k8s_namespace, hardDelete: true },
  }).catch((err) => log.error('Audit log failed', err));

  return { deviceUuid: uuid, deviceName: device.name };
}

export async function restartVirtualAgent(uuid: string) {
  const device = await AgentModel.getByUuid(uuid);
  if (!device) return { error: 'device_not_found' };
  if (device.type !== 'virtual') return { error: 'not_virtual' };

  log.info('Restarting virtual agent', {
    deviceUuid: uuid.substring(0, 8) + '...',
    deviceName: device.name,
    namespace: device.k8s_namespace,
  });

  await virtualAgentDeployer.restart(uuid);

  await logAuditEvent({
    eventType: 'device.deployment.restarted' as Parameters<typeof logAuditEvent>[0]['eventType'],
    agentUuid: uuid,
    severity: AuditSeverity.INFO,
    details: { deviceName: device.name, namespace: device.k8s_namespace },
  }).catch((err) => log.error('Audit log failed', err));

  return {
    deviceUuid: uuid,
    deviceName: device.name,
    namespace: device.k8s_namespace,
  };
}
