import { BaseProtocolAdapter, GenericDeviceConfig } from '../../../src/adapters/base';
import { DeviceDataPoint } from '../../../src/adapters/types';

class TestAdapter extends BaseProtocolAdapter {
  getProtocolName(): string {
    return 'test';
  }

  async connectDevice(device: GenericDeviceConfig): Promise<any> {
    return {}; 
  }

  async disconnectDevice(deviceName: string): Promise<void> {
    // Mock implementation
  }

  async readDeviceData(deviceName: string, device: GenericDeviceConfig): Promise<DeviceDataPoint[]> {
    return [];
  }

  async pollDevice(device: GenericDeviceConfig): Promise<DeviceDataPoint[]> {
    return [];
  }

  validateDeviceConfig(device: GenericDeviceConfig): void {
    if (!device.name) {
      throw new Error('Device name required');
    }
  }
}

describe('BaseProtocolAdapter', () => {
  let mockLogger: any;
  let devices: GenericDeviceConfig[];

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    devices = [];
  });

  it('should create adapter instance', () => {
    const adapter = new TestAdapter(devices, mockLogger);
    expect(adapter).toBeDefined();
  });

  it('should start with no devices', async () => {
    const adapter = new TestAdapter(devices, mockLogger);
    await adapter.start();
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  it('should stop adapter', async () => {
    const adapter = new TestAdapter(devices, mockLogger);
    await adapter.start();
    await adapter.stop();
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  it('should return empty device statuses', () => {
    const adapter = new TestAdapter(devices, mockLogger);
    const statuses = adapter.getDeviceStatuses();
    expect(statuses).toEqual([]);
  });

  it('should not start twice', async () => {
    const adapter = new TestAdapter(devices, mockLogger);
    await adapter.start();
    await adapter.start();
    
    const startCalls = mockLogger.info.mock.calls.filter(
      (call: any[]) => call[0].includes('Starting')
    );
    expect(startCalls.length).toBeLessThanOrEqual(1);
  });
});
