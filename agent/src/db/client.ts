/**
 * Database Client Interface for Device Manager
 * =============================================
 * 
 * Abstraction layer over database operations to make device-manager testable.
 * Allows easy mocking in tests without stubbing database calls.
 */

import { DeviceModel, type Device } from './models';

export type DeviceRecord = Device;

export interface DatabaseClient {
  /**
   * Load device record from database
   */
  loadDevice(): Promise<DeviceRecord | null>;
  
  /**
   * Save device record to database (insert or update)
   */
  saveDevice(data: Omit<DeviceRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<void>;
}

/**
 * Default implementation using DeviceModel
 */
export class SqliteDatabaseClient implements DatabaseClient {
  async loadDevice(): Promise<DeviceRecord | null> {
    return await DeviceModel.get();
  }
  
  async saveDevice(data: Omit<DeviceRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> {
    await DeviceModel.save(data);
  }
}
