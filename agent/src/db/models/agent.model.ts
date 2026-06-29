/**
 * Device Model
 * Manages device provisioning and registration data in SQLite
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AgentLogger } from '../../logging/agent-logger';
import { getDatabase } from '../sqlite';
import { 
	encryptData, 
	decryptData, 
	isEncrypted, 
	MasterKeyManager,
	ENCRYPTED_DEVICE_FIELDS 
} from '../../security/encryption';

export interface Agent {
  id?: number;
  uuid: string;
  name?: string | null;
  type?: string | null;
  deviceApiKey?: string | null;
  provisioningApiKey?: string | null;
  apiKey?: string | null;
  apiEndpoint?: string | null;
  registeredAt?: number | null;
  provisioned: boolean;
  provisioningState?: string | null;  // Provisioning state machine
  tenantId?: string | null;           // Tenant ID from provisioning response
  applicationId?: number | null;      // Deprecated: for backward compatibility
  macAddress?: string | null;
  osVersion?: string | null;
  agentVersion?: string | null;
  mqttUsername?: string | null;
  mqttPassword?: string | null;
  mqttBrokerUrl?: string | null;
  mqttBrokerConfig?: string | null; // JSON string of MqttBrokerConfig
  apiTlsConfig?: string | null;     // JSON string of ApiTlsConfig
  targetSyncEnabled?: boolean | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type AgentRow = Omit<Agent, 'provisioned'> & {
  provisioned: number;
};

export class AgentModel {
	private static table = 'agent';
	private static encryptionEnabled = false;
	private static readonly WRITE_COLUMNS: ReadonlyArray<keyof Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>> = [
		'uuid',
		'name',
		'type',
		'deviceApiKey',
		'provisioningApiKey',
		'apiKey',
		'apiEndpoint',
		'registeredAt',
		'provisioned',
		'provisioningState',
		'tenantId',
		'applicationId',
		'macAddress',
		'osVersion',
		'agentVersion',
		'mqttUsername',
		'mqttPassword',
		'mqttBrokerUrl',
		'mqttBrokerConfig',
		'apiTlsConfig',
		'targetSyncEnabled',
	];

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static toAgent(row: AgentRow): Agent {
		const decryptedDevice: Agent = {
			...row,
			provisioned: !!row.provisioned,
			targetSyncEnabled: (row as any).target_sync_enabled == null ? true : !!(row as any).target_sync_enabled,
		};

		if (this.encryptionEnabled) {
			const rowValues = row as Record<string, unknown>;
			const decryptedValues = decryptedDevice as unknown as Record<string, unknown>;

			for (const field of ENCRYPTED_DEVICE_FIELDS) {
				const value = rowValues[field];
				if (value && typeof value === 'string' && isEncrypted(value)) {
					try {
						decryptedValues[field] = decryptData(value);
					} catch (error) {
						console.error(`[DeviceModel] Failed to decrypt ${field}:`, error);
					}
				}
			}
		}

		return decryptedDevice;
	}

	private static buildCreateData(device: Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>): Record<string, string | number | null> {
		const now = new Date().toISOString();
		const createData: Record<string, string | number | null> = {
			createdAt: now,
			updatedAt: now,
		};

		for (const column of this.WRITE_COLUMNS) {
			const value = device[column];
			if (value === undefined) {
				continue;
			}

			if (column === 'provisioned' || column === 'targetSyncEnabled') {
				const colName = column === 'targetSyncEnabled' ? 'target_sync_enabled' : column;
				createData[colName] = value ? 1 : 0;
			} else {
				createData[column] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
			}
		}

		return createData;
	}

	private static buildUpdateData(updates: Partial<Agent>): Record<string, string | number | null> {
		const updateData: Record<string, string | number | null> = {
			updatedAt: new Date().toISOString(),
		};

		for (const column of this.WRITE_COLUMNS) {
			const value = updates[column];
			if (value === undefined) {
				continue;
			}

			if (column === 'provisioned' || column === 'targetSyncEnabled') {
				const colName = column === 'targetSyncEnabled' ? 'target_sync_enabled' : column;
				updateData[colName] = value ? 1 : 0;
			} else {
				updateData[column] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
			}
		}

		if (this.encryptionEnabled) {
			for (const field of ENCRYPTED_DEVICE_FIELDS) {
				const value = updates[field];
				if (value && typeof value === 'string' && !isEncrypted(value)) {
					try {
						updateData[field] = encryptData(value);
					} catch (error) {
						console.error(`[DeviceModel] Failed to encrypt ${field}:`, error);
					}
				}
			}
		}

		return updateData;
	}

	/**
   * Initialize encryption (must be called before first use)
   * @param dataDir - Directory for master key storage (defaults to /app/data for Docker)
   */
	static initializeEncryption(dataDir?: string, logger?: AgentLogger): void {
		try {
			MasterKeyManager.initialize(dataDir, logger);
			this.encryptionEnabled = true;
		} catch (error) {
			console.error('[DeviceModel] Failed to initialize encryption:', error);
			this.encryptionEnabled = false;
		}
	}

	/**
   * Get device record (single device per agent)
   */
	static async get(): Promise<Agent | null> {
		const device = this.getDb()
			.prepare(`SELECT * FROM ${this.table} LIMIT 1`)
			.get() as unknown as AgentRow | undefined;
    
		if (!device) {
			return null;
		}

		return this.toAgent(device);
	}

	/**
   * Create device record
   */
	static async create(device: Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>): Promise<Agent> {
		const createData = this.buildCreateData(device);
		const columns = Object.keys(createData);
		const values = Object.values(createData);

		this.getDb()
			.prepare(
				`INSERT INTO ${this.table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
			)
			.run(...values);

		return await this.get() as unknown as Agent;
	}

	/**
   * Update device record
   */
	static async update(updates: Partial<Agent>): Promise<Agent | null> {
		const updateData = this.buildUpdateData(updates);
		const columns = Object.keys(updateData);
		const values = Object.values(updateData);

		this.getDb()
			.prepare(`UPDATE ${this.table} SET ${columns.map((c) => `"${c}" = ?`).join(', ')}`)
			.run(...values);

		return await this.get();
	}

	/**
   * Save device record (insert or update)
   */
	static async save(data: Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>): Promise<Agent | null> {
		const existing = await this.get();

		if (existing) {
			return await this.update(data);
		} else {
			return await this.create(data);
		}
	}

	/**
   * Delete device record
   */
	static async delete(): Promise<boolean> {
		const result = this.getDb()
			.prepare(`DELETE FROM ${this.table}`)
			.run();
		return Number(result.changes) > 0;
	}

	/**
   * Check if device is provisioned
   */
	static async isProvisioned(): Promise<boolean> {
		const device = await this.get();
		return !!device?.provisioned;
	}

	/**
   * Get device UUID
   */
	static async getUuid(): Promise<string | null> {
		const device = await this.get();
		return device?.uuid || null;
	}

	/**
   * Update provisioning status
   */
	static async setProvisioned(provisioned: boolean): Promise<Agent | null> {
		return await this.update({ provisioned });
	}
}
