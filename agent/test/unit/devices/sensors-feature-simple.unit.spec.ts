import { SensorsFeature, SensorConfig } from '../../../src/features/adapters';
import { AgentLogger } from '../../../src/logging/agent-logger';

// Mock DeviceEndpointModel to avoid database dependencies in unit tests
jest.mock('../../../src/db/models/endpoint.model', () => ({
  DeviceEndpointModel: {
    getAll: jest.fn().mockResolvedValue([])
  }
}));

describe('SensorsFeature - Simple Tests', () => {
  let mockLogger: any;
  let config: SensorConfig;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    config = {
      enabled: true
    };
  });

  it('should create instance', () => {
    const feature = new SensorsFeature(config, mockLogger as any, 'test-123');
    expect(feature).toBeDefined();
  });

  it('should return empty statuses initially', async () => {
    const feature = new SensorsFeature(config, mockLogger as any, 'test-123');
    const statuses = await feature.getAllDeviceStatuses();
    expect(Object.keys(statuses).length).toBe(0);
  });

  it('should have undefined modbus adapter initially', () => {
    const feature = new SensorsFeature(config, mockLogger as any, 'test-123');
    const adapter = feature.getModbusAdapter();
    expect(adapter).toBeUndefined();
  });
});
