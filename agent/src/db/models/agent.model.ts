/**
 * Device Model
 * Manages device provisioning and registration data in SQLite
 */

import { models } from '../connection';
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
  createdAt?: Date;
  updatedAt?: Date;
}

export class AgentModel {
  private static table = 'agent';
  private static encryptionEnabled = false;

  /**
   * Initialize encryption (must be called before first use)
   * @param dataDir - Directory for master key storage (defaults to /app/data for Docker)
   */
  static initializeEncryption(dataDir?: string): void {
    try {
      MasterKeyManager.initialize(dataDir);
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
    const device = await models(this.table)
      .select('*')
      .first();
    
    if (!device) {
      return null;
    }

    // Convert provisioned to boolean
    const provisioned = !!device.provisioned;

    // Decrypt sensitive fields if encryption is enabled
    const decryptedDevice: Agent = {
      ...device,
      provisioned,
    };

    if (this.encryptionEnabled) {
      for (const field of ENCRYPTED_DEVICE_FIELDS) {
        const value = device[field];
        if (value && typeof value === 'string' && isEncrypted(value)) {
          try {
            decryptedDevice[field] = decryptData(value);
          } catch (error) {
            console.error(`[DeviceModel] Failed to decrypt ${field}:`, error);
            // Keep encrypted value if decryption fails (prevents data loss)
          }
        }
      }
    }

    return decryptedDevice;
  }

  /**
   * Create device record
   */
  static async create(device: Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>): Promise<Agent> {
    await models(this.table).insert({
      ...device,
      provisioned: device.provisioned ? 1 : 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return await this.get() as Agent;
  }

  /**
   * Update device record
   */
  static async update(updates: Partial<Agent>): Promise<Agent | null> {
    const updateData: any = {
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    if (updates.provisioned !== undefined) {
      updateData.provisioned = updates.provisioned ? 1 : 0;
    }

    // Encrypt sensitive fields if encryption is enabled
    if (this.encryptionEnabled) {
      for (const field of ENCRYPTED_DEVICE_FIELDS) {
        const value = updates[field];
        if (value && typeof value === 'string' && !isEncrypted(value)) {
          try {
            updateData[field] = encryptData(value);
          } catch (error) {
            console.error(`[DeviceModel] Failed to encrypt ${field}:`, error);
            // Keep plaintext if encryption fails (prevents data loss)
          }
        }
      }
    }

    await models(this.table).update(updateData);

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
    const deleted = await models(this.table).delete();
    return deleted > 0;
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
