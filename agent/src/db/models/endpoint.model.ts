/**
 * Endpoint Device Model
 * Manages protocol adapter device configurations (Modbus, CAN, OPC-UA) in SQLite
 */

import { models, getKnex } from '../connection';
import { EndpointOutputModel } from './endpoint-outputs.model';
// Use require for uuid to avoid ESM/CommonJS mismatch in Jest
const { v4: uuidv4 } = require('uuid');

export interface DeviceEndpoint {
  id?: number;
  uuid?: string; // Stable identifier for cloud/edge sync (survives name changes)
  name: string;
  protocol: 'modbus' | 'can' | 'opcua' | 'snmp' | 'mqtt';
  enabled: boolean;
  poll_interval: number;
  connection: Record<string, any>; // Connection config (host, port, serial, etc.)
  data_points?: any[]; // Protocol-agnostic: Modbus registers, OPC-UA nodes, CAN messages, etc.
  metadata?: Record<string, any>; // Additional protocol-specific config
  lastSeenAt?: Date; // Last seen during discovery (for stale device detection)
  created_at?: Date;
  updated_at?: Date;
}

export class DeviceEndpointModel {
  private static table = 'endpoints';

  /**
   * Get all protocol adapter devices
   */
  static async getAll(protocol?: string): Promise<DeviceEndpoint[]> {
    const query = models(this.table).select('*');
    if (protocol) {
      query.where('protocol', protocol);
    }
    const devices = await query.orderBy('name');
    
    // Parse JSON fields (SQLite stores as TEXT)
    return devices.map((d: any) => ({
      ...d,
      connection: typeof d.connection === 'string' ? JSON.parse(d.connection) : d.connection,
      data_points: d.data_points ? (typeof d.data_points === 'string' ? JSON.parse(d.data_points) : d.data_points) : null,
      metadata: d.metadata ? (typeof d.metadata === 'string' ? JSON.parse(d.metadata) : d.metadata) : null,
    }));
  }

  /**
   * Get device by name
   */
  static async getByName(name: string): Promise<DeviceEndpoint | null> {
    const device = await models(this.table)
      .where('name', name)
      .first();
    
    if (!device) return null;
    
    // Parse JSON fields (SQLite stores as TEXT)
    return {
      ...device,
      connection: typeof device.connection === 'string' ? JSON.parse(device.connection) : device.connection,
      data_points: device.data_points ? (typeof device.data_points === 'string' ? JSON.parse(device.data_points) : device.data_points) : null,
      metadata: device.metadata ? (typeof device.metadata === 'string' ? JSON.parse(device.metadata) : device.metadata) : null,
    };
  }

  /**
   * Get enabled devices for a protocol
   */
  static async getEnabled(protocol: string): Promise<DeviceEndpoint[]> {
    const devices = await models(this.table)
      .where({ protocol, enabled: true })
      .orderBy('name');
    
    // Parse JSON fields (SQLite stores as TEXT)
    return devices.map((d: any) => ({
      ...d,
      connection: typeof d.connection === 'string' ? JSON.parse(d.connection) : d.connection,
      data_points: d.data_points ? (typeof d.data_points === 'string' ? JSON.parse(d.data_points) : d.data_points) : null,
      metadata: d.metadata ? (typeof d.metadata === 'string' ? JSON.parse(d.metadata) : d.metadata) : null,
    }));
  }

  /**
   * Create new endpoint
   */
  static async create(device: DeviceEndpoint): Promise<DeviceEndpoint> {
    const [id] = await models(this.table).insert({
      ...device,
      uuid: device.uuid || uuidv4(), // Generate UUID if not provided
      connection: JSON.stringify(device.connection),
      data_points: device.data_points ? JSON.stringify(device.data_points) : null,
      metadata: device.metadata ? JSON.stringify(device.metadata) : null,
      lastSeenAt: device.lastSeenAt ? (device.lastSeenAt instanceof Date ? device.lastSeenAt.toISOString() : device.lastSeenAt) : null,
    });

    return await this.getById(id);
  }

  /**
   * Upsert endpoint (insert or update if name exists)
   * Used when target state may contain devices that were already discovered
   */
  static async upsert(device: DeviceEndpoint): Promise<DeviceEndpoint> {
    const existing = await this.getByName(device.name);
    
    if (existing) {
      // Update existing device
      return await this.update(device.name, device) as DeviceEndpoint;
    } else {
      // Create new device
      return await this.create(device);
    }
  }

  /**
   * Update endpoint
   */
  static async update(name: string, updates: Partial<DeviceEndpoint>): Promise<DeviceEndpoint | null> {
    const updateData: any = {
      ...updates,
      updated_at: new Date(),
    };

    if (updates.connection) {
      updateData.connection = JSON.stringify(updates.connection);
    }
    if (updates.data_points) {
      updateData.data_points = JSON.stringify(updates.data_points);
    }
    if (updates.metadata) {
      updateData.metadata = JSON.stringify(updates.metadata);
    }
    if (updates.lastSeenAt) {
      updateData.lastSeenAt = updates.lastSeenAt instanceof Date ? updates.lastSeenAt.toISOString() : updates.lastSeenAt;
    }

    await models(this.table)
      .where('name', name)
      .update(updateData);

    return await this.getByName(name);
  }

  /**
   * Delete endpoint
   */
  static async delete(name: string): Promise<boolean> {
    const deleted = await models(this.table)
      .where('name', name)
      .delete();
    return deleted > 0;
  }

  /**
   * Get endpoint by ID
   */
  private static async getById(id: number): Promise<DeviceEndpoint> {
    const device = await models(this.table)
      .where('id', id)
      .first();
    
    // Parse JSON fields (SQLite stores as TEXT)
    return {
      ...device,
      connection: typeof device.connection === 'string' ? JSON.parse(device.connection) : device.connection,
      data_points: device.data_points ? (typeof device.data_points === 'string' ? JSON.parse(device.data_points) : device.data_points) : null,
      metadata: device.metadata ? (typeof device.metadata === 'string' ? JSON.parse(device.metadata) : device.metadata) : null,
    };
  }

  /**
   * Get stale endpoints (not seen in X days)
   * NEVER auto-deletes - just marks for user review
   */
  static async getStaleDevices(daysThreshold = 7): Promise<DeviceEndpoint[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysThreshold);

    const devices = await models(this.table)
      .where('lastSeenAt', '<', cutoffDate.toISOString())
      .orWhereNull('lastSeenAt')
      .orderBy('lastSeenAt', 'asc');

    return devices.map((d: any) => ({
      ...d,
      connection: typeof d.connection === 'string' ? JSON.parse(d.connection) : d.connection,
      data_points: d.data_points ? (typeof d.data_points === 'string' ? JSON.parse(d.data_points) : d.data_points) : null,
      metadata: d.metadata ? (typeof d.metadata === 'string' ? JSON.parse(d.metadata) : d.metadata) : null,
    }));
  }

  /**
   * Update lastSeenAt timestamp for a endpoint
   */
  static async updateLastSeen(fingerprint: string): Promise<void> {
    await models(this.table)
      .where('metadata', 'like', `%"fingerprint":"${fingerprint}"%`)
      .update({ lastSeenAt: new Date().toISOString() });
  }

  /**
   * Import endpoints from JSON config (migration helper)
   */
  static async importFromJson(protocol: string, config: any): Promise<void> {
    const knex = getKnex();
    
    await knex.transaction(async (trx) => {
      // Import devices
      if (config.devices && Array.isArray(config.devices)) {
        for (const device of config.devices) {
          const existing = await trx(this.table).where('name', device.name).first();
          
          if (!existing) {
            await trx(this.table).insert({
              name: device.name,
              protocol,
              enabled: device.enabled !== undefined ? device.enabled : true,
              poll_interval: device.pollInterval || 5000,
              connection: JSON.stringify(device.connection),
              data_points: device.registers ? JSON.stringify(device.registers) : null,
              metadata: device.slaveId ? JSON.stringify({ slaveId: device.slaveId }) : null,
            });
          }
        }
      }

      // Import output config (using SensorOutputModel)
      if (config.output) {
        const existingOutput = await EndpointOutputModel.getOutput(protocol);
        
        if (!existingOutput) {
          await EndpointOutputModel.setOutput({
            protocol: protocol as 'modbus' | 'can' | 'opcua',
            socket_path: config.output.socketPath || config.output.socket_path,
            data_format: config.output.dataFormat || 'json',
            delimiter: config.output.delimiter || '\n',
            include_timestamp: config.output.includeTimestamp !== false,
            include_device_name: config.output.includeDeviceName !== false,
            logging: config.output.logging,
          });
        }
      }
    });
  }
}
