/**
 * DeviceManager Tests - Refactored Pattern
 * =========================================
 * 
 * Demonstrates testability improvements using dependency injection:
 * - MockHttpClient for API calls (no global fetch stubbing)
 * - MockDatabaseClient for database operations (no DB driver stubbing)
 * - Clean, isolated tests with predictable behavior
 */

import { AgentManager } from '../../../src/agent/agent';
import { MockHttpClient } from '../../helpers/mock-http-client';
import { MockDatabaseClient, MockUuidGenerator } from '../../helpers/mock-database-client';
import type { DeviceRecord } from '../../../src/db/client';
import type { ProvisionResponse } from '../../../src/agent/types';

describe('DeviceManager - Refactored Testability', () => {
	let deviceManager: AgentManager;
	let mockHttpClient: MockHttpClient;
	let mockDbClient: MockDatabaseClient;
	let mockUuidGenerator: MockUuidGenerator;

	beforeEach(() => {
		mockHttpClient = new MockHttpClient();
		mockDbClient = new MockDatabaseClient();
		mockUuidGenerator = new MockUuidGenerator();
		mockUuidGenerator.setUuid('test-uuid-123');
		deviceManager = new AgentManager(undefined, mockHttpClient, mockDbClient, mockUuidGenerator);
	});

	afterEach(() => {
		mockHttpClient.reset();
		mockDbClient.reset();
		mockUuidGenerator.reset();
	});

	// ============================================================================
	// CATEGORY 1: Initialization & Database Operations
	// ============================================================================

	describe('Initialization', () => {
		it('should create new device when database is empty', async () => {
			mockDbClient.mockNewDevice();
			mockDbClient.mockSuccessfulSave();

			await deviceManager.initialize();

			const agentInfo = deviceManager.getAgentInfo();
			expect(agentInfo.uuid).toBeTruthy();
			expect(agentInfo.apiKey).toBeTruthy();
			expect(agentInfo.provisioned).toBe(false);
			expect(mockDbClient.saveDeviceStub.callCount).toBe(1);
		});

		it('should load existing device from database', async () => {
			const existingDevice: DeviceRecord = {
				uuid: 'test-uuid-123',
				name: 'Test Device',
				type: 'sensor',
				deviceApiKey: 'existing-api-key',
				provisioningApiKey: null,
				apiKey: null,
				apiEndpoint: 'http://api:3002',
				registeredAt: Date.now(),
				provisioned: true,
				applicationId: 100,
				macAddress: '00:11:22:33:44:55',
				osVersion: 'Linux 5.10',
				agentVersion: '1.0.0',
				mqttUsername: 'device_test',
				mqttPassword: 'test-password',
				mqttBrokerUrl: 'mqtt://mosquitto:1883',
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			mockDbClient.mockExistingDevice(existingDevice);

			await deviceManager.initialize();

			const agentInfo = deviceManager.getAgentInfo();
			expect(agentInfo.uuid).toBe('test-uuid-123');
			expect(agentInfo.name).toBe('Test Device');
			expect(agentInfo.provisioned).toBe(true);
			expect(mockDbClient.loadDeviceStub.callCount).toBe(1);
		});
	});

	// ============================================================================
	// CATEGORY 2: Device Provisioning (Two-Phase Authentication)
	// ============================================================================

	describe('Provisioning', () => {
		beforeEach(async () => {
			mockDbClient.mockNewDevice();
			mockDbClient.mockSuccessfulSave();
			await deviceManager.initialize();
		});

		it('should complete two-phase provisioning successfully', async () => {
			const provisionResponse: ProvisionResponse = {
				id: 123,
				uuid: 'test-uuid',
				name: 'Test Device',
				type: 'sensor',
				challenge: 'test-challenge-nonce-12345',
				createdAt: new Date().toISOString(),
				mqtt: {
					username: 'device_test',
					password: 'mqtt-password',
					broker: 'mqtt://mosquitto:1883',
					brokerConfig: {
						protocol: 'mqtt',
						host: 'mosquitto',
						port: 1883,
						username: 'device_test',
						password: 'mqtt-password',
						useTls: false,
						verifyCertificate: false,
						clientIdPrefix: 'device',
						keepAlive: 60,
						cleanSession: true,
						reconnectPeriod: 1000,
						connectTimeout: 30000,
					},
					topics: {
						publish: 'iot/device/test-uuid/telemetry',
						subscribe: 'iot/device/test-uuid/commands',
					},
				},
			};

			// Phase 1: Register device
			mockHttpClient.mockPostSuccess(provisionResponse);

			// Phase 2: Exchange keys
			mockHttpClient.mockPostSuccess({ success: true });

			const result = await deviceManager.provision({
				provisioningApiKey: 'provisioning-key-123',
				apiEndpoint: 'http://api:3002',
				name: 'Test Device',
				type: 'sensor',
				applicationId: 100,
			});


		expect(result.mqttBrokerConfig?.username).toBe('device_test');
			expect(result.provisioned).toBe(true);
			expect(mockHttpClient.postStub.callCount).toBe(2); // register + exchange
			expect(mockDbClient.saveDeviceStub.callCount).toBeGreaterThanOrEqual(2);
		}, 35000); // Timeout: 30s per attempt + 5s buffer

		it('should throw error if provisioning API key missing', async () => {
			await expect(deviceManager.provision({
				apiEndpoint: 'http://api:3002',
			} as any)).rejects.toThrow('provisioningApiKey is required');
		});

		it('should handle registration failure gracefully', async () => {
			mockHttpClient.mockPostError(500, 'Internal Server Error');

			await expect(deviceManager.provision({
				provisioningApiKey: 'provisioning-key-123',
				apiEndpoint: 'http://api:3002',
			})).rejects.toThrow('Failed to register device');
		}, 240000); // Timeout: 6 attempts × 30s + backoff delays (211s max)
	});

	// ============================================================================
	// CATEGORY 3: API Communication
	// ============================================================================

	describe('API Communication', () => {
		beforeEach(async () => {
			mockDbClient.mockNewDevice();
			mockDbClient.mockSuccessfulSave();
			await deviceManager.initialize();
		});

		it('should send correct headers during registration', async () => {
			const provisionResponse: ProvisionResponse = {
				id: 123,
				uuid: 'test-uuid',
				name: 'Test Device',
				type: 'sensor',
				challenge: 'test-challenge-nonce-12345',
				createdAt: new Date().toISOString(),
				mqtt: {
					username: 'device_test',
					password: 'mqtt-password',
					broker: 'mqtt://mosquitto:1883',
					brokerConfig: {
						protocol: 'mqtt',
						host: 'mosquitto',
						port: 1883,
						username: 'device_test',
						password: 'mqtt-password',
						useTls: false,
						verifyCertificate: false,
						clientIdPrefix: 'device',
						keepAlive: 60,
						cleanSession: true,
						reconnectPeriod: 1000,
						connectTimeout: 30000,
					},
					topics: {
						publish: 'iot/device/test-uuid/telemetry',
						subscribe: 'iot/device/test-uuid/commands',
					},
				},
			};

			mockHttpClient.mockPostSuccess(provisionResponse);
			mockHttpClient.mockPostSuccess({ success: true }); // key exchange

			await deviceManager.provision({
				provisioningApiKey: 'provisioning-key-123',
				apiEndpoint: 'http://api:3002',
			});

			// Check first call (registration)
			const firstCallHeaders = mockHttpClient.postStub.firstCall.args[2]?.headers;
			expect(firstCallHeaders?.['Authorization']).toBe('Bearer provisioning-key-123');
			// Note: Content-Type is set automatically by HttpClient, not by DeviceManager
		}, 35000); // Timeout: 30s per attempt + 5s buffer

		it('should use deviceApiKey for key exchange', async () => {
			const provisionResponse: ProvisionResponse = {
				id: 123,
				uuid: 'test-uuid',
				name: 'Test Device',
				type: 'sensor',
				challenge: 'test-challenge-nonce-12345',
				createdAt: new Date().toISOString(),
				mqtt: {
					username: 'device_test',
					password: 'mqtt-password',
					broker: 'mqtt://mosquitto:1883',
					brokerConfig: {
						protocol: 'mqtt',
						host: 'mosquitto',
						port: 1883,
						username: 'device_test',
						password: 'mqtt-password',
						useTls: false,
						verifyCertificate: false,
						clientIdPrefix: 'device',
						keepAlive: 60,
						cleanSession: true,
						reconnectPeriod: 1000,
						connectTimeout: 30000,
					},
					topics: {
						publish: 'iot/device/test-uuid/telemetry',
						subscribe: 'iot/device/test-uuid/commands',
					},
				},
			};

			mockHttpClient.mockPostSuccess(provisionResponse);
			mockHttpClient.mockPostSuccess({ success: true });

			await deviceManager.provision({
				provisioningApiKey: 'provisioning-key-123',
				apiEndpoint: 'http://api:3002',
			});

			// Check second call (key exchange) - should use device API key
			const secondCallHeaders = mockHttpClient.postStub.secondCall.args[2]?.headers;
			expect(secondCallHeaders?.['Authorization']).toContain('Bearer');
		}, 35000); // Timeout: 30s per attempt + 5s buffer
	});

	// ============================================================================
	// CATEGORY 4: Device State Management
	// ============================================================================

	describe('State Management', () => {
		it('should update device name', async () => {
			mockDbClient.mockNewDevice();
			mockDbClient.mockSuccessfulSave();
			await deviceManager.initialize();

			await deviceManager.updateAgentName('New Device Name');

			const agentInfo = deviceManager.getAgentInfo();
			expect(agentInfo.name).toBe('New Device Name');
			expect(mockDbClient.saveDeviceStub.callCount).toBeGreaterThan(0);
		});

		it('should update API endpoint', async () => {
			mockDbClient.mockNewDevice();
			mockDbClient.mockSuccessfulSave();
			await deviceManager.initialize();

			await deviceManager.updateAPIEndpoint('http://new-api:3002');

			const agentInfo = deviceManager.getAgentInfo();
			expect(agentInfo.apiEndpoint).toBe('http://new-api:3002');
		});

		it('should reset device (unprovision)', async () => {
			const provisionedDevice: DeviceRecord = {
				uuid: 'test-uuid',
				deviceApiKey: 'api-key-123',
				provisioned: true,
				name: 'Test Device',
				type: 'sensor',
				provisioningApiKey: null,
				apiKey: null,
				apiEndpoint: 'http://api:3002',
				registeredAt: Date.now(),
				applicationId: 100,
				macAddress: null,
				osVersion: null,
				agentVersion: null,
				mqttUsername: null,
				mqttPassword: null,
				mqttBrokerUrl: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			mockDbClient.mockExistingDevice(provisionedDevice);
			mockDbClient.mockSuccessfulSave();
			await deviceManager.initialize();

			await deviceManager.reset();

			const agentInfo = deviceManager.getAgentInfo();
			expect(agentInfo.provisioned).toBe(false);
			expect(agentInfo.uuid).toBe('test-uuid'); // UUID preserved
			expect(agentInfo.apiKey).toBe('api-key-123'); // API key preserved
		});
	});

	// ============================================================================
	// CATEGORY 5: Error Handling
	// ============================================================================

	describe('Error Handling', () => {
		it('should throw error if getAgentInfo called before initialize', () => {
			const uninitializedManager = new AgentManager(undefined, mockHttpClient, mockDbClient);
			expect(() => uninitializedManager.getAgentInfo()).toThrow('Device manager not initialized');
		});

		it('should handle database save failure', async () => {
			mockDbClient.mockNewDevice();
			mockDbClient.mockSaveError(new Error('Database connection failed'));

			await expect(deviceManager.initialize()).rejects.toThrow('Database connection failed');
		});

		it('should handle network timeout during provisioning', async () => {
			mockDbClient.mockNewDevice();
			mockDbClient.mockSuccessfulSave();
			await deviceManager.initialize();

			mockHttpClient.mockTimeout();

			await expect(deviceManager.provision({
				provisioningApiKey: 'key-123',
				apiEndpoint: 'http://api:3002',
			})).rejects.toThrow();
		}, 35000); // Timeout: 30s per attempt + 5s buffer
	});
});
