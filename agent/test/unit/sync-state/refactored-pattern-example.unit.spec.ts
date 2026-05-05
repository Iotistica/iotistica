/**
 * Example: Complete Refactored Test Pattern
 * ==========================================
 * 
 * Shows how to write testable code using dependency injection
 * and the MockHttpClient pattern.
 */

import { MockHttpClient } from '../../helpers/mock-http-client';
import { CloudSync } from '../../../src/sync';
import { createMockAgentInfo, createMockTargetStateResponse } from '../../helpers/fixtures';
import { stub } from 'sinon';
import { EventEmitter } from 'events';

describe('Example: Refactored Testing Pattern', () => {
	it('should demonstrate clean, testable code', async () => {
		// 1. Create mock dependencies
		const mockHttpClient = new MockHttpClient();
		const mockAgentInfo = createMockAgentInfo();
		const mockDeviceManager = {
			getAgentInfo: () => mockAgentInfo
		};
		const mockStateReconciler = new EventEmitter() as any;
		mockStateReconciler.setTarget = stub().resolves();
		mockStateReconciler.getCurrentState = stub().resolves({ apps: {}, config: {} });
		
		// 2. Create system under test with injected mocks
		const cloudSync: any = new CloudSync(
			mockStateReconciler as any,
			mockDeviceManager as any,
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
		
		// 3. Configure mock behavior
		const targetState = createMockTargetStateResponse(mockAgentInfo.uuid);
		mockHttpClient.mockGetSuccess(targetState, { etag: 'abc123' });
		
		// 4. Execute test
		await cloudSync.pollTargetState();
		
		// 5. Verify behavior
		expect(mockHttpClient.getStub.callCount).toBe(1);
		expect(mockStateReconciler.setTarget.callCount).toBe(1);
		
		// 6. Verify HTTP request details
		const [url, options] = mockHttpClient.getStub.firstCall.args;
		expect(url).toContain('/api/v1/device');
		expect(url).toContain(mockAgentInfo.uuid);
		expect(options.headers['X-Device-API-Key']).toBe(mockAgentInfo.apiKey);
		// Note: timeout is passed to HttpClient but not visible in stubbed args
	});
	
	it('should demonstrate error handling', async () => {
		// Setup
		const mockHttpClient = new MockHttpClient();
		const cloudSync: any = new CloudSync(
			{} as any,
			{ getAgentInfo: () => createMockAgentInfo() } as any,
			{ cloudApiEndpoint: 'http://api:3002', apiTimeout: 30000 } as any,
			undefined, undefined, undefined, undefined,
			mockHttpClient
		);
		
		// Configure mock to return 500 error
		mockHttpClient.mockGetError(500, 'Internal Server Error');
		
		// Execute & Verify
		await expect(cloudSync.pollTargetState()).rejects.toThrow('HTTP 500');
	});
	
	it('should demonstrate timeout handling', async () => {
		// Setup
		const mockHttpClient = new MockHttpClient();
		const cloudSync: any = new CloudSync(
			{} as any,
			{ getAgentInfo: () => createMockAgentInfo() } as any,
			{ cloudApiEndpoint: 'http://api:3002', apiTimeout: 30000 } as any,
			undefined, undefined, undefined, undefined,
			mockHttpClient
		);
		
		// Configure mock to simulate timeout
		mockHttpClient.mockTimeout();
		
		// Execute & Verify
		await expect(cloudSync.pollTargetState()).rejects.toThrow('Target state poll timeout');
	});
});


