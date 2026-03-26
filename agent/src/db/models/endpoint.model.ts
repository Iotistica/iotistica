/**
 * Endpoint Device Model
 * Manages protocol adapter device configurations (Modbus, CAN, OPC-UA) in SQLite
 */

import { randomUUID } from 'crypto';
import { models, getKnex } from '../connection';
import { EndpointOutputModel } from './endpoint-outputs.model';

export interface Endpoint {
  id?: number;
  uuid?: string; // Stable identifier for cloud/edge sync (survives name changes)
  fingerprint?: string; // Cryptographic hash of physical identity (bus+slaveId+deviceId)
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

export class EndpointModel {
  private static table = 'endpoints';

  /**
   * Get all protocol adapter devices
   */
  static async getAll(protocol?: string): Promise<Endpoint[]> {
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
  static async getByName(name: string): Promise<Endpoint | null> {
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
   * Get device by UUID (recommended method for cloud/edge sync)
   */
  static async getByUuid(uuid: string): Promise<Endpoint | null> {
    // Guard: UUID must be defined
    if (!uuid) {
      console.warn('[WARN] getByUuid called with undefined/empty uuid');
      return null;
    }
    
    try {
  
      
      const device = await models(this.table)
        .where('uuid', uuid)
        .first();
      
      if (!device) return null;
      
      // Parse JSON fields (SQLite stores as TEXT)
      return {
        ...device,
        connection: typeof device.connection === 'string' ? JSON.parse(device.connection) : device.connection,
        data_points: device.data_points ? (typeof device.data_points === 'string' ? JSON.parse(device.data_points) : device.data_points) : null,
        metadata: device.metadata ? (typeof device.metadata === 'string' ? JSON.parse(device.metadata) : device.metadata) : null,
      };
    } catch (error: any) {
      console.error('[ERROR] getByUuid failed', {
        uuid,
        errorMessage: error.message,
        errorCode: error.code,
        fullError: error
      });
      throw error;
    }
  }

  /**
   * Get device by fingerprint (cryptographic hash of physical identity)
   * This is the RECOMMENDED lookup method for discovery - survives name changes
   */
  static async getByFingerprint(fingerprint: string): Promise<Endpoint | null> {
    const device = await models(this.table)
      .where('fingerprint', fingerprint)
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
  static async getEnabled(protocol: string): Promise<Endpoint[]> {
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
  static async create(device: Endpoint): Promise<Endpoint> {
    const [id] = await models(this.table).insert({
      ...device,
      uuid: device.uuid || randomUUID(), // Generate UUID if not provided
      connection: JSON.stringify(device.connection),
      data_points: device.data_points ? JSON.stringify(device.data_points) : null,
      metadata: device.metadata ? JSON.stringify(device.metadata) : null,
      lastSeenAt: device.lastSeenAt ? (device.lastSeenAt instanceof Date ? device.lastSeenAt.toISOString() : device.lastSeenAt) : null,
    });

    return await this.getById(id);
  }

  /**
   * Upsert endpoint (insert or update if fingerprint exists)
   * Uses fingerprint-based lookup for stability (survives name changes)
   * Fallback to name-based lookup for legacy devices without fingerprints
   */
  static async upsert(device: Endpoint): Promise<Endpoint> {
    // Primary: Lookup by fingerprint (if available)
    let existing: Endpoint | null = null;
    if (device.fingerprint) {
      existing = await this.getByFingerprint(device.fingerprint);
    }
    
    // Fallback: Lookup by name (for legacy devices or manual configs)
    if (!existing) {
      existing = await this.getByName(device.name);
    }
    
    if (existing) {
      // Update existing device (preserve UUID)
      return await this.updateByFingerprint(device.fingerprint || existing.fingerprint || '', device) as Endpoint;
    } else {
      // Create new device
      return await this.create(device);
    }
  }

  /**
   * Update endpoint (by name - legacy method)
   */
  static async update(name: string, updates: Partial<Endpoint>): Promise<Endpoint | null> {
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
   * Update endpoint by UUID (recommended method)
   */
  static async updateByUuid(uuid: string, updates: Partial<Endpoint>): Promise<Endpoint | null> {
    // Guard: UUID must be defined
    if (!uuid) {
      console.warn('[WARN] updateByUuid called with undefined/empty uuid');
      return null;
    }
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
      .where('uuid', uuid)
      .update(updateData);

    return await this.getByUuid(uuid);
  }

  /**
   * Update endpoint by fingerprint (recommended method)
   * Uses fingerprint for lookup, preserves UUID and other stable fields
   */
  static async updateByFingerprint(fingerprint: string, updates: Partial<Endpoint>): Promise<Endpoint | null> {
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
      .where('fingerprint', fingerprint)
      .update(updateData);

    return await this.getByFingerprint(fingerprint);
  }

  /**
   * Delete endpoint (by name - legacy method)
   */
  static async delete(name: string): Promise<boolean> {
    const deleted = await models(this.table)
      .where('name', name)
      .delete();
    return deleted > 0;
  }

  /**
   * Delete endpoint by UUID (recommended method)
   */
  static async deleteByUuid(uuid: string): Promise<boolean> {
    // Guard: UUID must be defined
    if (!uuid) {
      console.warn('[WARN] deleteByUuid called with undefined/empty uuid');
      return false;
    }
    const deleted = await models(this.table)
      .where('uuid', uuid)
      .delete();
    return deleted > 0;
  }

  /**
   * Get endpoint by ID
   */
  private static async getById(id: number): Promise<Endpoint> {
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
  static async getStaleDevices(daysThreshold = 7): Promise<Endpoint[]> {
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
   * Uses fingerprint column for fast indexed lookup
   */
  static async updateLastSeen(fingerprint: string): Promise<void> {
    await models(this.table)
      .where('fingerprint', fingerprint)
      .update({ lastSeenAt: new Date().toISOString() });
  }

  /**
   * Update lastSeenAt timestamp by device name
   * Fallback for devices without fingerprints (cloud-synced devices)
   */
  static async updateLastSeenByName(name: string): Promise<void> {
    await models(this.table)
      .where('name', name)
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
