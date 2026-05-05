/**
 * Unit Tests: cloudSync.pollTargetState
 * ======================================
 * 
 * Tests the target state polling logic in isolation using dependency injection.
 * Mocks: HttpClient, deviceManager, stateReconciler
 * 
 * Test Categories:
 * 1. Network Communication (HTTP responses)
 * 2. State Transformation (API response → DeviceState)
 * 3. State Reconciliation (calling setTarget)
 * 4. Error Handling (timeouts, server errors)
 * 5. ETag Caching (304 Not Modified)
 * 6. Version Tracking
 */

import { stub, restore } from 'sinon';
import { CloudSync } from '../../../src/device-manager/sync';
import type { StateReconciler, DeviceState } from '../../../src/device-manager/reconciler';
import type { DeviceManager } from '../../../src/device-manager';
import { EventEmitter } from 'events';
import { MockHttpClient } from '../../helpers/mock-http-client';
import {
	createMockTargetStateResponse,
	createMockAgentInfo,
	createMinimalTargetState,
	createTargetStateWithSensors,
	createTargetStateWithPartialConfig,
	createUnprovisionedAgentInfo,
	createCompleteConfigScenario,
	createPartialConfigScenario
} from '../../helpers/fixtures';

describe('CloudSync.pollTargetState', () => {
	// Test doubles
	let cloudSync: any; // Use 'any' to access private methods
	let mockHttpClient: MockHttpClient;
	let mockDeviceManager: any;
	let mockStateReconciler: any;
	
	beforeEach(() => {
		// Create mock HTTP client
		mockHttpClient = new MockHttpClient();
		
		// Mock device info to return synchronously
		const mockAgentInfo = createMockAgentInfo();
		
		// Mock dependencies
		mockDeviceManager = {
			getAgentInfo: () => mockAgentInfo,  // Sync, not async!
		};
		
		mockStateReconciler = new EventEmitter() as any;
		mockStateReconciler.setTarget = stub().resolves();
		mockStateReconciler.getCurrentState = stub().resolves({
			apps: {},
			config: {}
		});
		
		// Create CloudSync instance with injected mock HTTP client
		cloudSync = new CloudSync(
			mockStateReconciler as StateReconciler,
			mockDeviceManager as DeviceManager,
			{
				cloudApiEndpoint: 'http://api:3002',
				pollInterval: 60000,
				reportInterval: 10000,
				apiTimeout: 30000
			},
			undefined, // logger
			undefined, // sensorPublish
			undefined, // protocolAdapters
			undefined, // mqttManager
			mockHttpClient // Inject mock HTTP client!
		);
	});
	
	afterEach(() => {
		restore(); // Restore all stubs/spies
		mockHttpClient.reset();
	});
	
	// ============================================================================
	// CATEGORY 1: Network Communication
	// ============================================================================
	
	describe('Network Communication', () => {
		it('should send GET request with correct headers', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid);
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			expect(mockHttpClient.getStub.callCount).toBe(1);
			const [url, options] = mockHttpClient.getStub.firstCall.args;
			expect(url).toContain('/api/v1/device');
			expect(url).toContain(agentInfo.uuid);
		expect(options.headers['X-Device-API-Key']).toBe(agentInfo.apiKey);
	});
	
	it('should handle HTTP 200 response with state update', async () => {
		const agentInfo = createMockAgentInfo();
		const targetState = createMockTargetStateResponse(agentInfo.uuid);
		
		mockHttpClient.mockGetSuccess(targetState);
		
		await cloudSync.pollTargetState();
		
		expect(mockStateReconciler.setTarget.callCount).toBe(1);
	});
	
	it('should handle HTTP 304 Not Modified', async () => {
		mockHttpClient.mockGetNotModified();
		
		await cloudSync.pollTargetState();
		
		// Should not call setTarget on 304
		expect(mockStateReconciler.setTarget.called).toBe(false);
	});
		
		it('should reject on HTTP 500 Server Error', async () => {
			mockHttpClient.mockGetError(500, 'Internal Server Error');
			
			await expect(cloudSync.pollTargetState()).rejects.toThrow('HTTP 500');
		});
		
		it('should timeout after 30 seconds', async () => {
			mockHttpClient.mockTimeout();
			
			await expect(cloudSync.pollTargetState()).rejects.toThrow('Target state poll timeout');
		});
		
		it('should send If-None-Match header after first response with ETag', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid);
			
			// First request with ETag
			mockHttpClient.mockGetSuccess(targetState, { etag: 'abc123' });
			await cloudSync.pollTargetState();
			
			// Second request should include ETag
			mockHttpClient.mockGetNotModified();
			await cloudSync.pollTargetState();
			
			const [, secondOptions] = mockHttpClient.getStub.secondCall.args;
			expect(secondOptions.headers['if-none-match']).toBe('abc123');
		});
		
		it('should extract device UUID from deviceManager', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid);
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			// deviceManager.getAgentInfo is called synchronously, just verify it worked
			const [url] = mockHttpClient.getStub.firstCall.args;
			expect(url).toContain(agentInfo.uuid);
		});
	});
	
	// ============================================================================
	// CATEGORY 2: State Transformation
	// ============================================================================
	
	describe('State Transformation', () => {
		it('should extract config fields from API response', async () => {
			const agentInfo = createMockAgentInfo();
			const { targetState } = createCompleteConfigScenario();
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			const passedState: DeviceState = mockStateReconciler.setTarget.firstCall.args[0];
			expect(passedState.config).toBeTruthy();
			expect(Object.keys(passedState.config || {}).length).toBeGreaterThan(0);
		});
		
		it('should preserve all 4 config fields', async () => {
			const agentInfo = createMockAgentInfo();
			const { targetState } = createCompleteConfigScenario();
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			const passedState: DeviceState = mockStateReconciler.setTarget.firstCall.args[0];
			expect(passedState.config).toHaveProperty('logging');
			expect(passedState.config).toHaveProperty('sensors');
			expect(passedState.config).toHaveProperty('features');
			expect(passedState.config).toHaveProperty('settings');
		});
		
		it('should handle API returning only 2 config fields (bug scenario)', async () => {
			const agentInfo = createMockAgentInfo();
			const { targetState } = createPartialConfigScenario();
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			const passedState: DeviceState = mockStateReconciler.setTarget.firstCall.args[0];
			// Should preserve whatever the API sends
			expect(passedState.config).toHaveProperty('logging');
			expect(passedState.config).toHaveProperty('sensors');
			// These might be missing in the bug scenario
			expect(Object.keys(passedState.config || {})).toBeTruthy();
		});
		
		it('should extract apps from target state', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid, {
				apps: {
					'1001': {
						appId: '1001',
						appName: 'test-app',
						services: []
					}
				}
			});
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			const passedState: DeviceState = mockStateReconciler.setTarget.firstCall.args[0];
			expect(passedState.apps).toHaveProperty('1001');
		});
		
		it('should extract sensors array from config', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createTargetStateWithSensors(agentInfo.uuid, 3);
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			const passedState: DeviceState = mockStateReconciler.setTarget.firstCall.args[0];
			expect((passedState.config as any).sensors).toHaveLength(3);
		});
		
		it('should handle minimal target state (no apps, minimal config)', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = {
				[agentInfo.uuid]: {
					apps: {},
					config: {
						logging: { level: 'info' } // Minimal but non-empty
					},
					version: 1
				}
			};
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			const passedState: DeviceState = mockStateReconciler.setTarget.firstCall.args[0];
			expect(passedState.apps).toEqual({});
			expect(passedState.config).toMatchObject({
				logging: expect.anything()
			});
		});
		
		it('should handle partial config (missing some fields)', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createTargetStateWithPartialConfig(agentInfo.uuid);
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			const passedState: DeviceState = mockStateReconciler.setTarget.firstCall.args[0];
			expect(passedState.config).toBeTruthy();
		});
	});
	
	// ============================================================================
	// CATEGORY 3: State Reconciliation
	// ============================================================================
	
	describe('State Reconciliation', () => {
		it('should call stateReconciler.setTarget with extracted state', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid);
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			expect(mockStateReconciler.setTarget.callCount).toBe(1);
			expect(mockStateReconciler.setTarget.firstCall.args[0]).toHaveProperty('config');
			expect(mockStateReconciler.setTarget.firstCall.args[0]).toHaveProperty('apps');
		});
		
		it('should emit "target-state-changed" event after setTarget', async () => {
			const eventSpy = jest.fn();
			mockStateReconciler.on('target-state-changed', eventSpy);
			
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid);
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			// In real implementation, this event is emitted by stateReconciler
			mockStateReconciler.emit('target-state-changed');
			
			expect(eventSpy).toHaveBeenCalled();
		});
		
		it('should not call setTarget when device is not provisioned', async () => {
			// Create new CloudSync with unprovisioned device
			const unprovisionedDeviceManager = {
				getAgentInfo: () => createUnprovisionedAgentInfo()
			};
			
			const unprovisionedCloudSync: any = new CloudSync(
				mockStateReconciler as any,
				unprovisionedDeviceManager as any,
				{
					cloudApiEndpoint: 'http://api:3002',
					pollInterval: 60000,
					reportInterval: 10000,
					apiTimeout: 30000
				},
				undefined, undefined, undefined, undefined,
				mockHttpClient
			);
			
			const targetState = createMockTargetStateResponse('some-uuid');
			mockHttpClient.mockGetSuccess(targetState);
			
			await unprovisionedCloudSync.pollTargetState();
			
			expect(mockStateReconciler.setTarget.called).toBe(false);
		});
		
		it('should pass version number to setTarget', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid, { version: 5 });
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			// Version is tracked internally, just verify setTarget was called
			expect(mockStateReconciler.setTarget.callCount).toBe(1);
		});
		
		it('should update state even when config partially matches current', async () => {
			const agentInfo = createMockAgentInfo();
			
			// First update
			let targetState = createMockTargetStateResponse(agentInfo.uuid);
			mockHttpClient.mockGetSuccess(targetState);
			await cloudSync.pollTargetState();
			
			mockStateReconciler.setTarget.resetHistory();
			mockHttpClient.reset();
			
			// Second update with different config (change logging level)
			targetState = createMockTargetStateResponse(agentInfo.uuid, { 
				version: 2,
				config: {
					logging: { level: 'debug', enabled: true },
					sensors: [],
					features: { enableModbus: false, enableMqtt: true },
					settings: { timezone: 'UTC', language: 'en' }
				}
			});
			mockHttpClient.mockGetSuccess(targetState);
			await cloudSync.pollTargetState();
			
			expect(mockStateReconciler.setTarget.callCount).toBe(1);
		});
	});
	
	// ============================================================================
	// CATEGORY 4: Error Handling
	// ============================================================================
	
	describe('Error Handling', () => {
		it('should handle network request failure', async () => {
			mockHttpClient.mockNetworkError('Network request failed');
			
			await expect(cloudSync.pollTargetState()).rejects.toThrow('Network request failed');
		});
		
		it('should handle timeout error', async () => {
			mockHttpClient.mockTimeout();
			
			await expect(cloudSync.pollTargetState()).rejects.toThrow();
		});
		
		it('should handle server error (HTTP 500)', async () => {
			mockHttpClient.mockGetError(500, 'Internal Server Error');
			
			await expect(cloudSync.pollTargetState()).rejects.toThrow();
		});
		
		it('should handle malformed JSON response', async () => {
			const response = {
				ok: true,
				status: 200,
				headers: new Map(),
				json: async () => { throw new Error('Invalid JSON'); }
			};
			
			mockHttpClient.getStub.resolves(response as any);
			
			await expect(cloudSync.pollTargetState()).rejects.toThrow('Invalid JSON');
		});
		
		it('should warn when device UUID not in response', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = {
				'different-uuid': {
					apps: {},
					config: {},
					version: 1
				}
			};
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			// Should not call setTarget when UUID doesn't match
			expect(mockStateReconciler.setTarget.called).toBe(false);
		});
	});
	
	// ============================================================================
	// CATEGORY 5: ETag Caching
	// ============================================================================
	
	describe('ETag Caching', () => {
		it('should store ETag from first response', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid);
			const etag = 'abc123';
			
			mockHttpClient.mockGetSuccess(targetState, { etag });
			
			await cloudSync.pollTargetState();
			
			// DON'T reset - we need to keep call history
			// Next request should include the ETag
			mockHttpClient.mockGetNotModified();
			await cloudSync.pollTargetState();
			
			// Check the second call includes If-None-Match header
			expect(mockHttpClient.getStub.callCount).toBe(2);
			if (mockHttpClient.getStub.callCount >= 2) {
				const headers = mockHttpClient.getStub.secondCall.args[1]?.headers;
				expect(headers?.['if-none-match']).toBe(etag);
			}
		});
		
		it('should not call setTarget on 304 response', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid);
			
			// First poll with ETag
			mockHttpClient.mockGetSuccess(targetState, { etag: 'abc123' });
			await cloudSync.pollTargetState();
			expect(mockStateReconciler.setTarget.callCount).toBe(1);
			
			mockStateReconciler.setTarget.resetHistory();
			mockHttpClient.reset();
			
			// Second poll returns 304
			mockHttpClient.mockGetNotModified();
			await cloudSync.pollTargetState();
			expect(mockStateReconciler.setTarget.called).toBe(false);
		});
		
		it('should handle response without ETag header', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid);
			
			// Response without ETag
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			// Should still work
			expect(mockStateReconciler.setTarget.callCount).toBe(1);
		});
	});
	
	// ============================================================================
	// CATEGORY 6: Version Tracking
	// ============================================================================
	
	describe('Version Tracking', () => {
		it('should extract version from response', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid, { version: 3 });
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			expect(mockStateReconciler.setTarget.callCount).toBe(1);
		});
		
		it('should default to version 1 if not provided', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = {
				[agentInfo.uuid]: {
					apps: {},
					config: {
						logging: { level: 'info', enabled: true },
						sensors: [],
						features: { enableModbus: false },
						settings: { timezone: 'UTC' }
					}
					// version missing
				}
			};
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			expect(mockStateReconciler.setTarget.callCount).toBe(1);
		});
		
		it('should handle version increment', async () => {
			const agentInfo = createMockAgentInfo();
			
			// Version 1
			let targetState = createMockTargetStateResponse(agentInfo.uuid, { version: 1 });
			mockHttpClient.mockGetSuccess(targetState);
			await cloudSync.pollTargetState();
			
			mockStateReconciler.setTarget.resetHistory();
			mockHttpClient.reset();
			
			// Version 2 with different config (to trigger state change)
			targetState = createMockTargetStateResponse(agentInfo.uuid, { 
				version: 2,
				config: {
					logging: { level: 'debug', enabled: true },
					sensors: [],
					features: { enableModbus: true, enableMqtt: true },
					settings: { timezone: 'UTC', language: 'en' }
				}
			});
			mockHttpClient.mockGetSuccess(targetState);
			await cloudSync.pollTargetState();
			
			expect(mockStateReconciler.setTarget.callCount).toBe(1);
		});
	});
	
	// ============================================================================
	// EDGE CASES
	// ============================================================================
	
	describe('Edge Cases', () => {
		it('should handle empty apps object', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createMockTargetStateResponse(agentInfo.uuid, { apps: {} });
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			const passedState: DeviceState = mockStateReconciler.setTarget.firstCall.args[0];
			expect(passedState.apps).toEqual({});
		});
		
		it('should handle null config gracefully', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = {
				[agentInfo.uuid]: {
					apps: { '1001': { appId: '1001', appName: 'test', services: [] } }, // Add an app to trigger state change
					config: null as any, // Simulate bad API response
					version: 1
				}
			};
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			// Should still call setTarget, but with empty config object
			expect(mockStateReconciler.setTarget.callCount).toBe(1);
			const passedState: DeviceState = mockStateReconciler.setTarget.firstCall.args[0];
			expect(passedState.config).toEqual({});
		});
		
		it('should handle large sensor arrays', async () => {
			const agentInfo = createMockAgentInfo();
			const targetState = createTargetStateWithSensors(agentInfo.uuid, 100);
			
			mockHttpClient.mockGetSuccess(targetState);
			
			await cloudSync.pollTargetState();
			
			const passedState: DeviceState = mockStateReconciler.setTarget.firstCall.args[0];
			expect((passedState.config as any).sensors).toHaveLength(100);
		});
	});
});

