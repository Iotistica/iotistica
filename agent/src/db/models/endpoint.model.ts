/**
 * Endpoint Device Model
 * Manages protocol adapter device configurations (Modbus, CAN, OPC-UA) in SQLite
 */

import { randomUUID } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase, transact } from '../sqlite';
import { EndpointOutputModel } from './endpoint-outputs.model';

export interface Endpoint {
  id?: number;
  uuid?: string; // Stable identifier for cloud/edge sync (survives name changes)
  fingerprint?: string; // Cryptographic hash of physical identity (bus+slaveId+deviceId)
  name: string;
  protocol: 'modbus' | 'can' | 'opcua' | 'snmp' | 'mqtt';
  groupName?: string; // Custom adapter group name (e.g., "warehouse-modbus", "factory-opcua") for multi-instance support
  enabled: boolean;
  poll_interval: number;
  connection: Record<string, any>; // Connection config (host, port, serial, etc.)
  data_points?: any[]; // Protocol-agnostic: Modbus registers, OPC-UA nodes, CAN messages, etc.
  metadata?: Record<string, any>; // Additional protocol-specific config
  lastSeenAt?: Date; // Last seen during discovery (for stale device detection)
  created_at?: Date;
  updated_at?: Date;
}

type EndpointRow = Omit<Endpoint, 'enabled' | 'connection' | 'data_points' | 'metadata'> & {
  enabled: number;
  connection: string | Record<string, any>;
  data_points?: string | any[] | null;
  metadata?: string | Record<string, any> | null;
  group_name?: string | null;
};

export class EndpointModel {
	private static table = 'endpoints';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static parseRow(row: EndpointRow | undefined): Endpoint | null {
		if (!row) {
			return null;
		}

		return {
			id: row.id,
			uuid: row.uuid,
			fingerprint: row.fingerprint,
			name: row.name,
			protocol: row.protocol,
			groupName: row.group_name || undefined,
			enabled: !!row.enabled,
			poll_interval: row.poll_interval,
			connection: typeof row.connection === 'string' ? JSON.parse(row.connection) : row.connection,
			data_points: row.data_points ? (typeof row.data_points === 'string' ? JSON.parse(row.data_points) : row.data_points) : null,
			metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null,
			lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt as any) : undefined,
			created_at: row.created_at ? new Date(row.created_at as any) : undefined,
			updated_at: row.updated_at ? new Date(row.updated_at as any) : undefined,
		};
	}

	private static parseRows(rows: EndpointRow[]): Endpoint[] {
		return rows
			.map((row) => this.parseRow(row))
			.filter((row): row is Endpoint => row !== null);
	}

	private static serializeEndpoint(endpoint: Partial<Endpoint>, includeDefaults: boolean = false): Record<string, string | number | null> {
		const serialized: Record<string, string | number | null> = {};

		if (endpoint.uuid !== undefined || includeDefaults) serialized.uuid = endpoint.uuid ?? null;
		if (endpoint.fingerprint !== undefined || includeDefaults) serialized.fingerprint = endpoint.fingerprint ?? null;
		if (endpoint.name !== undefined) serialized.name = endpoint.name;
		if (endpoint.protocol !== undefined) serialized.protocol = endpoint.protocol;
		if (endpoint.groupName !== undefined || includeDefaults) serialized.group_name = endpoint.groupName ?? null;
		if (endpoint.enabled !== undefined || includeDefaults) serialized.enabled = endpoint.enabled === undefined ? 1 : (endpoint.enabled ? 1 : 0);
		if (endpoint.poll_interval !== undefined || includeDefaults) serialized.poll_interval = endpoint.poll_interval ?? 5000;
		if (endpoint.connection !== undefined) serialized.connection = JSON.stringify(endpoint.connection);
		if (endpoint.data_points !== undefined) serialized.data_points = endpoint.data_points ? JSON.stringify(endpoint.data_points) : null;
		if (endpoint.metadata !== undefined) serialized.metadata = endpoint.metadata ? JSON.stringify(endpoint.metadata) : null;
		if (endpoint.lastSeenAt !== undefined) {
			serialized.lastSeenAt = endpoint.lastSeenAt instanceof Date ? endpoint.lastSeenAt.toISOString() : endpoint.lastSeenAt;
		}

		return serialized;
	}

	/**
   * Get all protocol adapter devices
   */
	static async getAll(protocol?: string): Promise<Endpoint[]> {
		const devices = protocol
			? this.getDb().prepare(`SELECT * FROM ${this.table} WHERE protocol = ? ORDER BY name ASC`).all(protocol) as unknown as EndpointRow[]
			: this.getDb().prepare(`SELECT * FROM ${this.table} ORDER BY name ASC`).all() as unknown as EndpointRow[];

		return this.parseRows(devices);
	}

	/**
   * Get device by name
   */
	static async getByName(name: string): Promise<Endpoint | null> {
		const device = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE name = ? LIMIT 1`)
			.get(name) as unknown as EndpointRow | undefined;

		return this.parseRow(device);
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
			const device = this.getDb()
				.prepare(`SELECT * FROM ${this.table} WHERE uuid = ? LIMIT 1`)
				.get(uuid) as unknown as EndpointRow | undefined;

			return this.parseRow(device);
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
		const device = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE fingerprint = ? LIMIT 1`)
			.get(fingerprint) as unknown as EndpointRow | undefined;

		return this.parseRow(device);
	}

	/**
   * Get enabled devices for a protocol
   */
	static async getEnabled(protocol: string): Promise<Endpoint[]> {
		const devices = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE protocol = ? AND enabled = 1 ORDER BY name ASC`)
			.all(protocol) as unknown as EndpointRow[];

		return this.parseRows(devices);
	}

	/**
   * Create new endpoint
   */
	static async create(device: Endpoint): Promise<Endpoint> {
		const serialized = this.serializeEndpoint({
			...device,
			uuid: device.uuid || randomUUID(),
			enabled: device.enabled,
			poll_interval: device.poll_interval,
		}, true);

		const columns = Object.keys(serialized);
		const values = Object.values(serialized);
		const result = this.getDb()
			.prepare(
				`INSERT INTO ${this.table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
			)
			.run(...values);

		return await this.getById(Number(result.lastInsertRowid));
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
		const updateData = {
			...this.serializeEndpoint(updates),
			updated_at: new Date().toISOString(),
		};

		const columns = Object.keys(updateData);
		const values = [...Object.values(updateData), name];
		this.getDb()
			.prepare(`UPDATE ${this.table} SET ${columns.map((c) => `"${c}" = ?`).join(', ')} WHERE name = ?`)
			.run(...values);

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
		const updateData = {
			...this.serializeEndpoint(updates),
			updated_at: new Date().toISOString(),
		};

		const columns = Object.keys(updateData);
		const values = [...Object.values(updateData), uuid];
		this.getDb()
			.prepare(`UPDATE ${this.table} SET ${columns.map((c) => `"${c}" = ?`).join(', ')} WHERE uuid = ?`)
			.run(...values);

		return await this.getByUuid(uuid);
	}

	/**
   * Update endpoint by fingerprint (recommended method)
   * Uses fingerprint for lookup, preserves UUID and other stable fields
   */
	static async updateByFingerprint(fingerprint: string, updates: Partial<Endpoint>): Promise<Endpoint | null> {
		const updateData = {
			...this.serializeEndpoint(updates),
			updated_at: new Date().toISOString(),
		};

		const columns = Object.keys(updateData);
		const values = [...Object.values(updateData), fingerprint];
		this.getDb()
			.prepare(`UPDATE ${this.table} SET ${columns.map((c) => `"${c}" = ?`).join(', ')} WHERE fingerprint = ?`)
			.run(...values);

		return await this.getByFingerprint(fingerprint);
	}

	/**
   * Delete endpoint (by name - legacy method)
   */
	static async delete(name: string): Promise<boolean> {
		const result = this.getDb()
			.prepare(`DELETE FROM ${this.table} WHERE name = ?`)
			.run(name);
		return Number(result.changes) > 0;
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
		const result = this.getDb()
			.prepare(`DELETE FROM ${this.table} WHERE uuid = ?`)
			.run(uuid);
		return Number(result.changes) > 0;
	}

	static deleteMissingUuid(): number {
		return Number(this.getDb()
			.prepare(`DELETE FROM ${this.table} WHERE uuid IS NULL`)
			.run().changes);
	}

	/**
   * Get endpoint by ID
   */
	private static async getById(id: number): Promise<Endpoint> {
		const device = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE id = ? LIMIT 1`)
			.get(id) as unknown as EndpointRow | undefined;

		return this.parseRow(device) as Endpoint;
	}

	/**
   * Get stale endpoints (not seen in X days)
   * NEVER auto-deletes - just marks for user review
   */
	static async getStaleDevices(daysThreshold = 7): Promise<Endpoint[]> {
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - daysThreshold);

		const devices = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE lastSeenAt < ? OR lastSeenAt IS NULL ORDER BY lastSeenAt ASC`)
			.all(cutoffDate.toISOString()) as unknown as EndpointRow[];

		return this.parseRows(devices);
	}

	/**
   * Update lastSeenAt timestamp for a endpoint
   * Uses fingerprint column for fast indexed lookup
   */
	static async updateLastSeen(fingerprint: string): Promise<void> {
		this.getDb()
			.prepare(`UPDATE ${this.table} SET lastSeenAt = ? WHERE fingerprint = ?`)
			.run(new Date().toISOString(), fingerprint);
	}

	/**
   * Update lastSeenAt timestamp by device name
   * Fallback for devices without fingerprints (cloud-synced devices)
   */
	static async updateLastSeenByName(name: string): Promise<void> {
		this.getDb()
			.prepare(`UPDATE ${this.table} SET lastSeenAt = ? WHERE name = ?`)
			.run(new Date().toISOString(), name);
	}

	/**
   * Import endpoints from JSON config (migration helper)
   */
	static async importFromJson(protocol: string, config: any): Promise<void> {
		const db = this.getDb();

		transact(db, () => {
			// Import devices
			if (config.devices && Array.isArray(config.devices)) {
				for (const device of config.devices) {
					const existing = db
						.prepare(`SELECT id FROM ${this.table} WHERE name = ? LIMIT 1`)
						.get(device.name);

					if (!existing) {
						db
							.prepare(`
                INSERT INTO ${this.table} (
                  uuid,
                  name,
                  protocol,
                  enabled,
                  poll_interval,
                  connection,
                  data_points,
                  metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `)
							.run(
								randomUUID(),
								device.name,
								protocol,
								device.enabled !== undefined ? (device.enabled ? 1 : 0) : 1,
								device.pollInterval || 5000,
								JSON.stringify(device.connection),
								device.registers ? JSON.stringify(device.registers) : null,
								device.slaveId ? JSON.stringify({ slaveId: device.slaveId }) : null,
							);
					}
				}
			}
		});

		// Import output config after the device transaction. EndpointOutputModel now
		// uses the shared direct SQLite helper and exposes an async API.
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
	}
}
