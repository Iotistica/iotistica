/**
 * Protocol Devices Model
 *
 * Manages the `devices` table — the physical/logical devices reachable
 * through protocol endpoints.
 *
 * Relationship to endpoints:
 *   endpoint = the connection point  (Modbus TCP bus, OPC-UA server URL)
 *   device   = a device accessible via that connection
 *
 *   Modbus  → N slaves per bus endpoint, identifier = slaveId string
 *   OPC-UA  → N logical devices per server endpoint, identifier = device_uuid
 *   BACnet/SNMP/MQTT/CAN → 1:1 with endpoint, identifier = null
 *
 * The `uuid` column is the stable identity carried in metric payloads
 * (deviceDataPoint.device_uuid).
 */

import { randomUUID } from 'crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getDatabase } from '../sqlite';
import type { Endpoint } from './endpoint.model';

export interface Device {
  id?: number;
  /** Stable UUID used in metric payloads (deviceDataPoint.device_uuid) */
  uuid: string;
  endpoint_id: number;
  name: string;
  protocol: string;
  enabled: boolean;
  /**
   * Protocol-specific sub-address within the endpoint:
   *   Modbus  → slaveId as string ("3")
   *   OPC-UA  → device_uuid from the DeviceUUID node
   *   others  → undefined/null
   */
  identifier?: string | null;
  metadata?: Record<string, any>;
  lastSeenAt?: Date | string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

type DeviceRow = Omit<Device, 'enabled' | 'metadata'> & {
  enabled: number;
  metadata?: string | Record<string, any> | null;
};

export class DeviceModel {
	private static readonly table = 'devices';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	static async getAll(protocol?: string): Promise<Device[]> {
		const rows = protocol
			? this.getDb().prepare(`SELECT * FROM ${this.table} WHERE protocol = ? ORDER BY name ASC`).all(protocol) as unknown as DeviceRow[]
			: this.getDb().prepare(`SELECT * FROM ${this.table} ORDER BY name ASC`).all() as unknown as DeviceRow[];

		return rows.map(this.parse);
	}

	/**
   * Return all devices joined with their parent endpoint UUID.
   * Used by CloudSync to include the `devices` field in state reports so the
   * cloud can store agent-reported devices without re-parsing endpoint metadata.
   */
	static async getAllWithEndpointUuid(): Promise<Array<Device & { endpoint_uuid: string }>> {
		const rows = this.getDb()
			.prepare(`
        SELECT d.*, e.uuid as endpoint_uuid
        FROM devices d
        JOIN endpoints e ON e.id = d.endpoint_id
        ORDER BY d.name ASC
      `)
			.all() as unknown as Array<DeviceRow & { endpoint_uuid: string }>;

		return rows.map((row) => ({ ...this.parse(row), endpoint_uuid: row.endpoint_uuid }));
	}

	static async getByEndpointId(endpointId: number): Promise<Device[]> {
		const rows = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE endpoint_id = ?`)
			.all(endpointId) as unknown as DeviceRow[];

		return rows.map(this.parse);
	}

	static async getByUuid(uuid: string): Promise<Device | null> {
		const row = this.getDb()
			.prepare(`SELECT * FROM ${this.table} WHERE uuid = ? LIMIT 1`)
			.get(uuid) as unknown as DeviceRow | undefined;

		return row ? this.parse(row) : null;
	}

	static async updateLastSeen(uuid: string): Promise<void> {
		const now = new Date().toISOString();
		this.getDb()
			.prepare(`UPDATE ${this.table} SET lastSeenAt = ?, updated_at = ? WHERE uuid = ?`)
			.run(now, now, uuid);
	}

	/**
   * Update lastSeenAt for all devices belonging to the named endpoint.
   * Called from the poll adapters on each successful read.
   */
	static async updateLastSeenByEndpointName(endpointName: string): Promise<void> {
		const db = this.getDb();
		const now = new Date().toISOString();
		const endpoint = db
			.prepare('SELECT id FROM endpoints WHERE name = ? LIMIT 1')
			.get(endpointName) as { id: number } | undefined;

		if (!endpoint) return;

		db.prepare(`UPDATE ${this.table} SET lastSeenAt = ?, updated_at = ? WHERE endpoint_id = ?`)
			.run(now, now, endpoint.id);
	}

	/**
   * Upsert a device by (endpoint_id, identifier).
   * For 1:1 protocols (identifier null/undefined), matches on endpoint_id alone.
   */
	static async upsertDevice(device: Omit<Device, 'id'>): Promise<void> {
		const db = this.getDb();
		const now = new Date().toISOString();

		const hasIdentifier = device.identifier !== undefined && device.identifier !== null;

		const existing = hasIdentifier
			? db
				.prepare(`SELECT id FROM ${this.table} WHERE endpoint_id = ? AND identifier = ? LIMIT 1`)
				.get(device.endpoint_id, device.identifier ?? null) as unknown as { id: number } | undefined
			: db
				.prepare(`SELECT id FROM ${this.table} WHERE endpoint_id = ? AND identifier IS NULL LIMIT 1`)
				.get(device.endpoint_id) as { id: number } | undefined;

		if (existing) {
			db.prepare(`
        UPDATE ${this.table}
        SET name = ?,
            enabled = ?,
            metadata = ?,
            lastSeenAt = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
				device.name,
				device.enabled ? 1 : 0,
				device.metadata ? JSON.stringify(device.metadata) : null,
				device.lastSeenAt instanceof Date ? device.lastSeenAt.toISOString() : (device.lastSeenAt ?? null),
				now,
				existing.id,
			);
		} else {
			db.prepare(`
        INSERT INTO ${this.table} (
          uuid,
          endpoint_id,
          name,
          protocol,
          enabled,
          identifier,
          metadata,
          lastSeenAt,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
				device.uuid,
				device.endpoint_id,
				device.name,
				device.protocol,
				device.enabled ? 1 : 0,
				device.identifier ?? null,
				device.metadata ? JSON.stringify(device.metadata) : null,
				device.lastSeenAt instanceof Date ? device.lastSeenAt.toISOString() : (device.lastSeenAt ?? null),
				now,
				now,
			);
		}
	}

	/**
   * Sync device rows from a saved endpoint.
   * Called after endpoint create/update in discovery to keep devices in step.
   *
   * Modbus  → 1 device per per-slave endpoint  (identifier = slaveId)
   * OPC-UA  → 1 device per device_uuid group in data_points;
   *           the catch-all default group (nodes without a device_uuid) is only
   *           persisted when the server exposes NO device grouping at all —
   *           stray untagged nodes are silently ignored when real devices exist
   * Others  → 1 device mirroring the endpoint  (no identifier)
   */
	static async syncFromEndpoint(endpoint: Endpoint): Promise<void> {
		if (!endpoint.id) return;

		const endpointId = endpoint.id;
		const protocol = endpoint.protocol;
		const lastSeenAt = endpoint.lastSeenAt ?? null;

		if (protocol === 'modbus') {
			const slaveId = endpoint.connection?.slaveId;
			if (slaveId === undefined) return;

			await this.upsertDevice({
				uuid: endpoint.uuid || randomUUID(),
				endpoint_id: endpointId,
				name: endpoint.name,
				protocol,
				enabled: endpoint.enabled,
				identifier: String(slaveId),
				metadata: { slaveId },
				lastSeenAt,
			});

		} else if (protocol === 'opcua') {
			const dataPoints: any[] = endpoint.data_points || [];

			// Collect distinct device_uuid values (undefined → '__default__')
			const seen = new Map<string, number>(); // device_uuid → node count
			for (const dp of dataPoints) {
				const key = dp.device_uuid || '__default__';
				seen.set(key, (seen.get(key) ?? 0) + 1);
			}

			if (seen.size === 0) {
				// No data points yet — placeholder device for the server
				await this.upsertDevice({
					uuid: endpoint.uuid || randomUUID(),
					endpoint_id: endpointId,
					name: endpoint.name,
					protocol,
					enabled: endpoint.enabled,
					identifier: null,
					lastSeenAt,
				});
				return;
			}

			const hasIdentifiedDevices = [...seen.keys()].some(k => k !== '__default__');

			for (const [deviceUuid, nodeCount] of seen) {
				const isDefault = deviceUuid === '__default__';

				// Skip the catch-all default group when there are real identified devices.
				// Stray untagged nodes are an artefact of servers that only partially expose
				// DeviceUUID — they don't represent a distinct physical device.
				// Only emit a default row when the server exposes NO device grouping at all.
				if (isDefault && hasIdentifiedDevices) continue;

				// Name matches the format the metric pipeline already emits:
				//   "{endpoint.name}-{first8ofUuid}" for identified devices,
				//   "{endpoint.name}" for the catch-all default group.
				const uuidSuffix = isDefault ? '' : deviceUuid.replace(/-/g, '').slice(0, 8);
				const devName = isDefault ? endpoint.name : `${endpoint.name}-${uuidSuffix}`;

				await this.upsertDevice({
					uuid: isDefault ? (endpoint.uuid || randomUUID()) : deviceUuid,
					endpoint_id: endpointId,
					name: devName,
					protocol,
					enabled: endpoint.enabled,
					identifier: isDefault ? null : deviceUuid,
					metadata: { nodeCount },
					lastSeenAt,
				});
			}

		} else {
			// BACnet, SNMP, MQTT, CAN — 1:1 with the endpoint
			await this.upsertDevice({
				uuid: endpoint.uuid || randomUUID(),
				endpoint_id: endpointId,
				name: endpoint.name,
				protocol,
				enabled: endpoint.enabled,
				identifier: null,
				lastSeenAt,
			});
		}
	}

	private static parse(row: DeviceRow): Device {
		return {
			...row,
			enabled: Boolean(row.enabled),
			metadata: row.metadata
				? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata)
				: undefined,
		};
	}
}
