import { AdapterManager, AdapterConfig } from '../../../src/adapters';
import { AgentLogger } from '../../../src/logging/agent-logger';

// Mock DeviceEndpointModel to avoid database dependencies in unit tests
jest.mock('../../../src/db/models/endpoint.model', () => ({
  DeviceEndpointModel: {
    getAll: jest.fn().mockResolvedValue([])
  }
}));

describe('AdapterManager - Simple Tests', () => {
  let mockLogger: any;
  let config: AdapterConfig;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    config = {};
  });

  it('should create instance', () => {
    const manager = new AdapterManager(config, mockLogger as any, 'test-123');
    expect(manager).toBeDefined();
  });

  it('should return empty statuses initially', async () => {
    const manager = new AdapterManager(config, mockLogger as any, 'test-123');
    const statuses = await manager.getAllDeviceStatuses();
    expect(Object.keys(statuses).length).toBe(0);
  });

  it('should have undefined modbus adapter initially', () => {
    const manager = new AdapterManager(config, mockLogger as any, 'test-123');
    const adapter = manager.getAdapter('modbus');
    expect(adapter).toBeUndefined();
  });
});
