/**
 * Container Log Monitor - Container Recreation Tests
 * 
 * Tests the LogMonitor's ability to handle container recreation by looking up
 * containers by service name when the original container ID becomes stale.
 */

import { ContainerLogMonitor } from '../../src/logging/docker-monitor';
import type Docker from 'dockerode';
import type { AgentLogger } from '../../src/logging/agent-logger';

describe('ContainerLogMonitor - Container Recreation', () => {
	let mockDocker: jest.Mocked<Docker>;
	let mockLogger: jest.Mocked<AgentLogger>;
	let monitor: ContainerLogMonitor;

	beforeEach(() => {
		// Mock Docker client
		mockDocker = {
			getContainer: jest.fn(),
			listContainers: jest.fn(),
		} as any;

		// Mock Logger
		mockLogger = {
			debugSync: jest.fn(),
			infoSync: jest.fn(),
			warnSync: jest.fn(),
			errorSync: jest.fn(),
			getBackends: jest.fn(() => []),
		} as any;

		monitor = new ContainerLogMonitor(mockDocker, mockLogger);
	});

	describe('findContainerByServiceName', () => {
		it('should find container by Docker Compose label', async () => {
			// Arrange: Mock container list with Compose labels
			mockDocker.listContainers.mockResolvedValue([
				{
					Id: 'new-container-id-12345678',
					Names: ['/mosquitto'],
					Labels: {
						'com.docker.compose.service': 'mosquitto',
						'com.docker.compose.project': 'iotistic',
					},
				},
			] as any);

			// Act: Call private method via reflection
			const findMethod = (monitor as any).findContainerByServiceName.bind(monitor);
			const result = await findMethod('mosquitto');

			// Assert
			expect(result).toBe('new-container-id-12345678');
			expect(mockDocker.listContainers).toHaveBeenCalledWith({ all: true });
		});

		it('should fall back to container name matching', async () => {
			// Arrange: Mock container without Compose labels
			mockDocker.listContainers.mockResolvedValue([
				{
					Id: 'standalone-container-id',
					Names: ['/mosquitto-standalone'],
					Labels: {},
				},
			] as any);

			// Act
			const findMethod = (monitor as any).findContainerByServiceName.bind(monitor);
			const result = await findMethod('mosquitto');

			// Assert
			expect(result).toBe('standalone-container-id');
		});

		it('should return null if service not found', async () => {
			// Arrange: Mock empty container list
			mockDocker.listContainers.mockResolvedValue([]);

			// Act
			const findMethod = (monitor as any).findContainerByServiceName.bind(monitor);
			const result = await findMethod('nonexistent-service');

			// Assert
			expect(result).toBeNull();
		});

		it('should handle Docker API errors gracefully', async () => {
			// Arrange: Mock Docker API failure
			mockDocker.listContainers.mockRejectedValue(new Error('Docker daemon unreachable'));

			// Act
			const findMethod = (monitor as any).findContainerByServiceName.bind(monitor);
			const result = await findMethod('mosquitto');

			// Assert
			expect(result).toBeNull();
			expect(mockLogger.errorSync).toHaveBeenCalledWith(
				'Failed to find container by service name',
				expect.any(Error),
				expect.objectContaining({
					serviceName: 'mosquitto',
				}),
			);
		});
	});

	describe('Container Recreation Scenario', () => {
		let mockLogStream: any;
		let mockContainer: any;

		beforeEach(() => {
			// Mock log stream
			mockLogStream = {
				on: jest.fn((event, handler) => {
					// Store handlers for later triggering
					if (!mockLogStream._handlers) mockLogStream._handlers = {};
					mockLogStream._handlers[event] = handler;
					return mockLogStream;
				}),
				destroy: jest.fn(),
			};

			// Mock container
			mockContainer = {
				logs: jest.fn().mockResolvedValue(mockLogStream),
			};

			mockDocker.getContainer.mockReturnValue(mockContainer);
		});

		it('should detect container recreation and update to new ID', async () => {
			// Arrange: Initial attachment to old container
			const oldContainerId = 'old-container-id-12345678';
			const newContainerId = 'new-container-id-87654321';
			const serviceName = 'mosquitto';

			// Initial successful attachment
			await monitor.attach({
				containerId: oldContainerId,
				serviceId: 1,
				serviceName,
			});

			// Simulate container recreation: old ID fails with 404
			mockDocker.getContainer.mockImplementation((id: string) => {
				if (id === oldContainerId) {
					throw new Error('(HTTP code 404) no such container - No such container: ' + id);
				}
				return mockContainer;
			});

			// Mock listContainers to return new container ID
			mockDocker.listContainers.mockResolvedValue([
				{
					Id: newContainerId,
					Names: ['/mosquitto'],
					Labels: { 'com.docker.compose.service': serviceName },
				},
			] as any);

			// Act: Trigger reconnection (simulate stream error)
			const reconnectMethod = (monitor as any).attemptReconnection.bind(monitor);
			await reconnectMethod(oldContainerId);

			// Assert: Should have logged container recreation
			expect(mockLogger.infoSync).toHaveBeenCalledWith(
				'Container recreated with new ID, updating attachment',
				expect.objectContaining({
					oldContainerId: oldContainerId.substring(0, 12),
					newContainerId: newContainerId.substring(0, 12),
					serviceName,
				}),
			);

			// Should have attempted to attach to new container
			expect(mockDocker.getContainer).toHaveBeenCalledWith(newContainerId);
		});

		it('should keep retrying if service not found (may be recreating)', async () => {
			// Arrange: Container attached
			const containerId = 'temp-removed-container-id';
			const serviceName = 'mosquitto';

			await monitor.attach({
				containerId,
				serviceId: 1,
				serviceName,
			});

			// Simulate temporary removal: listContainers returns empty (container being recreated)
			mockDocker.listContainers.mockResolvedValue([]);
			mockDocker.getContainer.mockImplementation(() => {
				throw new Error('(HTTP code 404) no such container');
			});

			// Act: Trigger reconnection
			const reconnectMethod = (monitor as any).attemptReconnection.bind(monitor);
			await reconnectMethod(containerId);

			// Assert: Should log debug message about retrying
			expect(mockLogger.debugSync).toHaveBeenCalledWith(
				'Container not found, will retry',
				expect.objectContaining({
					serviceName,
					message: 'Container may be deleted or in process of being recreated',
				}),
			);

			// Should NOT clean up reconnection options (keep trying)
			const reconnectionOptions = (monitor as any).reconnectionOptions;
			expect(reconnectionOptions.has(containerId)).toBe(true);
		});

		it('should stop reconnection after max retries exceeded', async () => {
			// Arrange: Mock RetryManager to indicate terminal state
			const mockRetryManager = (monitor as any).retryManager;
			mockRetryManager.shouldRetry = jest.fn().mockReturnValue(false);
			mockRetryManager.isTerminal = jest.fn().mockReturnValue(true);

			const containerId = 'permanently-removed-id';
			const serviceName = 'removed-service';

			// Set up reconnection options
			(monitor as any).reconnectionOptions.set(containerId, {
				containerId,
				serviceId: 1,
				serviceName,
			});

			// Act: Try to schedule reconnection
			const scheduleMethod = (monitor as any).scheduleReconnection.bind(monitor);
			scheduleMethod(containerId, 'Max retries');

			// Assert: Should warn about permanent failure
			expect(mockLogger.warnSync).toHaveBeenCalledWith(
				'Log stream reconnection failed permanently',
				expect.objectContaining({
					serviceName,
					message: 'Max retries exceeded. Container will reattach if recreated by reconciliation.',
				}),
			);

			// Should clean up reconnection options
			const reconnectionOptions = (monitor as any).reconnectionOptions;
			expect(reconnectionOptions.has(containerId)).toBe(false);
		});

		it('should classify 404 errors as warnings, not errors', async () => {
			// Arrange: Mock 404 error
			mockDocker.getContainer.mockImplementation(() => {
				throw new Error('(HTTP code 404) no such container - 452bf858fe59');
			});

			// Act: Try to attach
			try {
				await monitor.attach({
					containerId: 'nonexistent-id',
					serviceId: 1,
					serviceName: 'test-service',
				});
			} catch (error) {
				// Expected to throw
			}

			// Assert: Should log as warning, not error
			expect(mockLogger.warnSync).toHaveBeenCalledWith(
				'Container not found - may have been recreated',
				expect.objectContaining({
					message: 'Will attempt to find container by service name on reconnect',
				}),
			);

			// Should NOT log as error
			expect(mockLogger.errorSync).not.toHaveBeenCalled();
		});

		it('should log non-404 errors as errors', async () => {
			// Arrange: Mock non-404 error
			mockDocker.getContainer.mockImplementation(() => {
				throw new Error('Docker daemon unreachable');
			});

			// Act: Try to attach
			try {
				await monitor.attach({
					containerId: 'test-id',
					serviceId: 1,
					serviceName: 'test-service',
				});
			} catch (error) {
				// Expected to throw
			}

			// Assert: Should log as error
			expect(mockLogger.errorSync).toHaveBeenCalledWith(
				'Failed to attach to container',
				expect.any(Error),
				expect.anything(),
			);
		});
	});

	describe('Edge Cases', () => {
		it('should handle rapid container recreation (multiple ID changes)', async () => {
			// Arrange: Multiple containers with same service name
			const serviceName = 'mosquitto';
			const containerIds = [
				'first-container-id-123',
				'second-container-id-456',
				'third-container-id-789',
			];

			let currentIdIndex = 0;

			mockDocker.listContainers.mockImplementation(async () => {
				return [
					{
						Id: containerIds[currentIdIndex],
						Names: [`/${serviceName}`],
						Labels: { 'com.docker.compose.service': serviceName },
					},
				] as any;
			});

			// Mock container to fail on old IDs
			const mockContainer = {
				logs: jest.fn().mockResolvedValue({
					on: jest.fn().mockReturnThis(),
					destroy: jest.fn(),
				}),
			};

			mockDocker.getContainer.mockImplementation((id: string) => {
				if (id === containerIds[currentIdIndex]) {
					return mockContainer;
				}
				throw new Error('(HTTP code 404) no such container');
			});

			// Act: Attach, then simulate recreation 3 times
			const findMethod = (monitor as any).findContainerByServiceName.bind(monitor);

			const result1 = await findMethod(serviceName);
			expect(result1).toBe(containerIds[0]);

			currentIdIndex = 1;
			const result2 = await findMethod(serviceName);
			expect(result2).toBe(containerIds[1]);

			currentIdIndex = 2;
			const result3 = await findMethod(serviceName);
			expect(result3).toBe(containerIds[2]);

			// Assert: Should successfully discover each new ID
			expect(mockDocker.listContainers).toHaveBeenCalledTimes(3);
		});

		it('should prioritize Compose labels over name matching', async () => {
			// Arrange: Two containers with similar names
			mockDocker.listContainers.mockResolvedValue([
				{
					Id: 'wrong-container-id',
					Names: ['/mosquitto-backup'],
					Labels: { 'com.docker.compose.service': 'mosquitto-backup' },
				},
				{
					Id: 'correct-container-id',
					Names: ['/mosquitto'],
					Labels: { 'com.docker.compose.service': 'mosquitto' },
				},
			] as any);

			// Act
			const findMethod = (monitor as any).findContainerByServiceName.bind(monitor);
			const result = await findMethod('mosquitto');

			// Assert: Should match exact label, not substring
			expect(result).toBe('correct-container-id');
		});
	});
});
