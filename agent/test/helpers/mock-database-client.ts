/**
 * Mock Database Client for Testing
 * =================================
 * 
 * Provides controllable database operations for testing DeviceManager
 * without requiring actual database access.
 */

import { stub } from 'sinon';
import type { DatabaseClient, DeviceRecord } from '../../src/db/client';
import type { UuidGenerator } from '../../src/provisioning/device-manager';

export class MockDatabaseClient implements DatabaseClient {
	public loadDeviceStub = stub<[], Promise<DeviceRecord | null>>();
	public saveDeviceStub = stub<[Omit<DeviceRecord, 'createdAt'>], Promise<void>>();

	async loadAgent(): Promise<DeviceRecord | null> {
		return this.loadDeviceStub();
	}

	async saveAgent(data: Omit<DeviceRecord, 'createdAt'>): Promise<void> {
		return this.saveDeviceStub(data);
	}

	/**
	 * Helper: Mock loadDevice to return null (new device)
	 */
	mockNewDevice(): void {
		this.loadDeviceStub.resolves(null);
	}

	/**
	 * Helper: Mock loadDevice to return existing device
	 */
	mockExistingDevice(deviceRecord: DeviceRecord): void {
		this.loadDeviceStub.resolves(deviceRecord);
	}

	/**
	 * Helper: Mock successful save
	 */
	mockSuccessfulSave(): void {
		this.saveDeviceStub.resolves();
	}

	/**
	 * Helper: Mock save error
	 */
	mockSaveError(error: Error): void {
		this.saveDeviceStub.rejects(error);
	}

	/**
	 * Reset all stubs for next test
	 */
	reset(): void {
		this.loadDeviceStub.reset();
		this.saveDeviceStub.reset();
	}
}

/**
 * Mock UUID Generator for Testing
 * ================================
 * 
 * Provides predictable UUIDs for testing
 */
export class MockUuidGenerator implements UuidGenerator {
	private counter = 0;
	private customUuid?: string;

	/**
	 * Generate predictable UUID for testing
	 */
	generate(): string {
		if (this.customUuid) {
			return this.customUuid;
		}
		return `test-uuid-${this.counter++}`;
	}

	/**
	 * Set a specific UUID to be returned
	 */
	setUuid(uuid: string): void {
		this.customUuid = uuid;
	}

	/**
	 * Reset counter and custom UUID
	 */
	reset(): void {
		this.counter = 0;
		this.customUuid = undefined;
	}
}
