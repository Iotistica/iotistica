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
  loadAgent(): Promise<DeviceRecord | null>;
  
  /**
   * Save device record to database (insert or update)
   */
  saveAgent(data: Omit<DeviceRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<void>;
}

/**
 * Default implementation using DeviceModel
 */
export class SqliteDatabaseClient implements DatabaseClient {
	async loadAgent(): Promise<DeviceRecord | null> {
		return await DeviceModel.get();
	}
  
	async saveAgent(data: Omit<DeviceRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> {
		await DeviceModel.save(data);
	}
}
