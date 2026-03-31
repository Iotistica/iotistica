/**
 * Unit tests for Modbus Adapter
 * Tests core adapter logic without real Modbus connections
 */

// Mock uuid before imports to avoid ESM/CommonJS issues in Jest
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-12345')
}));

import { ModbusAdapter } from '../../../../src/features/adapters/modbus/adapter';
import { ModbusAdapterConfig, ModbusConnectionType } from '../../../../src/features/adapters/modbus/types';
import { DeviceDataPoint } from '../../../../src/features/adapters/types';

describe('ModbusAdapter', () => {
  let mockLogger: any;
  let mockConfig: ModbusAdapterConfig;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    mockConfig = {
      devices: [],
      logging: {
        level: 'info',
        enableConsole: false,
        enableFile: false
      }
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Basic Adapter Functions', () => {
    it('should create adapter instance', () => {
      const adapter = new ModbusAdapter(mockConfig, mockLogger);
      expect(adapter).toBeDefined();
    });

    it('should return empty device statuses when no devices', () => {
      const adapter = new ModbusAdapter(mockConfig, mockLogger);
      const statuses = adapter.getDeviceStatuses();
      expect(statuses).toEqual([]);
    });
  });

  describe('Device Management', () => {
    it('should initialize device statuses', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      const statuses = adapter.getDeviceStatuses();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].deviceName).toBe('test_device');
      expect(statuses[0].connected).toBe(false);
    });

    it('should get specific device status', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      const status = adapter.getDeviceStatus('test_device');
      expect(status).toBeDefined();
      expect(status?.deviceName).toBe('test_device');
    });

    it('should return undefined for non-existent device', () => {
      const adapter = new ModbusAdapter(mockConfig, mockLogger);
      const status = adapter.getDeviceStatus('non_existent');
      expect(status).toBeUndefined();
    });

    it('should track multiple devices', () => {
      const config = {
        ...mockConfig,
        devices: [
          {
            name: 'device1',
            enabled: true,
            slaveId: 1,
            pollInterval: 1000,
            registers: [],
            connection: {
              type: ModbusConnectionType.TCP,
              host: 'localhost',
              port: 502,
              baudRate: 9600,
              dataBits: 8,
              stopBits: 1,
              parity: 'none' as const,
              timeout: 5000,
              retryAttempts: 3,
              retryDelay: 1000
            }
          },
          {
            name: 'device2',
            enabled: true,
            slaveId: 2,
            pollInterval: 2000,
            registers: [],
            connection: {
              type: ModbusConnectionType.TCP,
              host: 'localhost',
              port: 502,
              baudRate: 9600,
              dataBits: 8,
              stopBits: 1,
              parity: 'none' as const,
              timeout: 5000,
              retryAttempts: 3,
              retryDelay: 1000
            }
          }
        ]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      const statuses = adapter.getDeviceStatuses();
      expect(statuses).toHaveLength(2);
      expect(statuses.map(s => s.deviceName)).toEqual(['device1', 'device2']);
    });

    it('should initialize both enabled and disabled devices', () => {
      const config = {
        ...mockConfig,
        devices: [
          {
            name: 'enabled_device',
            enabled: true,
            slaveId: 1,
            pollInterval: 1000,
            registers: [],
            connection: {
              type: ModbusConnectionType.TCP,
              host: 'localhost',
              port: 502,
              baudRate: 9600,
              dataBits: 8,
              stopBits: 1,
              parity: 'none' as const,
              timeout: 5000,
              retryAttempts: 3,
              retryDelay: 1000
            }
          },
          {
            name: 'disabled_device',
            enabled: false,
            slaveId: 2,
            pollInterval: 2000,
            registers: [],
            connection: {
              type: ModbusConnectionType.TCP,
              host: 'localhost',
              port: 502,
              baudRate: 9600,
              dataBits: 8,
              stopBits: 1,
              parity: 'none' as const,
              timeout: 5000,
              retryAttempts: 3,
              retryDelay: 1000
            }
          }
        ]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      // All devices initialized, enabled flag only affects polling
      const statuses = adapter.getDeviceStatuses();
      expect(statuses).toHaveLength(2);
      expect(statuses.map(s => s.deviceName)).toEqual(['enabled_device', 'disabled_device']);
    });
  });

  describe('Error Handling', () => {
    it('should extract TIMEOUT quality code', () => {
      const adapter = new ModbusAdapter(mockConfig, mockLogger);
      
      const result = (adapter as any).extractQualityCode('ETIMEDOUT');
      expect(result).toBe('TIMEOUT');
    });

    it('should extract CONNECTION_REFUSED quality code', () => {
      const adapter = new ModbusAdapter(mockConfig, mockLogger);
      
      const result = (adapter as any).extractQualityCode('ECONNREFUSED');
      expect(result).toBe('CONNECTION_REFUSED');
    });

    it('should extract HOST_NOT_FOUND quality code', () => {
      const adapter = new ModbusAdapter(mockConfig, mockLogger);
      
      const result = (adapter as any).extractQualityCode('ENOTFOUND');
      expect(result).toBe('HOST_NOT_FOUND');
    });

    it('should extract DEVICE_OFFLINE quality code', () => {
      const adapter = new ModbusAdapter(mockConfig, mockLogger);
      
      const result = (adapter as any).extractQualityCode('not open');
      expect(result).toBe('DEVICE_OFFLINE');
    });

    it('should handle lowercase timeout', () => {
      const adapter = new ModbusAdapter(mockConfig, mockLogger);
      
      const result = (adapter as any).extractQualityCode('Connection timeout');
      expect(result).toBe('TIMEOUT');
    });

    it('should return UNKNOWN_ERROR for unrecognized error messages', () => {
      const adapter = new ModbusAdapter(mockConfig, mockLogger);
      
      const result = (adapter as any).extractQualityCode('Some unknown error');
      expect(result).toBe('UNKNOWN_ERROR');
    });
  });

  describe('Performance Tracking', () => {
    it('should track register changes on first poll', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      const dataPoints: DeviceDataPoint[] = [
        {
          deviceName: 'test_device',
          timestamp: new Date().toISOString(),
          value: 42,
          quality: 'GOOD',
          metric: 'register_1',
          unit: ''
        },
        {
          deviceName: 'test_device',
          timestamp: new Date().toISOString(),
          value: 23,
          quality: 'GOOD',
          metric: 'register_2',
          unit: ''
        }
      ];

      const changedCount = (adapter as any).trackRegisterChanges('test_device', dataPoints);
      
      // First time all registers are "changed"
      expect(changedCount).toBe(2);
    });

    it('should detect unchanged registers on subsequent polls', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      const dataPoints: DeviceDataPoint[] = [
        {
          deviceName: 'test_device',
          timestamp: new Date().toISOString(),
          value: 42,
          quality: 'GOOD',
          metric: 'register_1',
          unit: ''
        }
      ];

      // First poll
      (adapter as any).trackRegisterChanges('test_device', dataPoints);
      
      // Second poll with same value
      const changedCount = (adapter as any).trackRegisterChanges('test_device', dataPoints);
      
      // No changes detected
      expect(changedCount).toBe(0);
    });

    it('should detect when register value changes', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      const dataPointsFirst: DeviceDataPoint[] = [
        {
          deviceName: 'test_device',
          timestamp: new Date().toISOString(),
          value: 42,
          quality: 'GOOD',
          metric: 'register_1',
          unit: ''
        }
      ];

      // First poll
      (adapter as any).trackRegisterChanges('test_device', dataPointsFirst);
      
      // Second poll with different value
      const dataPointsSecond: DeviceDataPoint[] = [
        {
          deviceName: 'test_device',
          timestamp: new Date().toISOString(),
          value: 100,
          quality: 'GOOD',
          metric: 'register_1',
          unit: ''
        }
      ];
      
      const changedCount = (adapter as any).trackRegisterChanges('test_device', dataPointsSecond);
      
      // Change detected
      expect(changedCount).toBe(1);
    });

    it('should calculate offline quality for disconnected device', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      const status = adapter.getDeviceStatus('test_device')!;
      
      const quality = (adapter as any).calculateCommunicationQuality(status);
      expect(quality).toBe('offline');
    });

    it('should calculate good quality for high success rate', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      const status = adapter.getDeviceStatus('test_device')!;
      status.connected = true;
      status.pollSuccessRate = 0.98;
      
      const quality = (adapter as any).calculateCommunicationQuality(status);
      expect(quality).toBe('good');
    });

    it('should calculate degraded quality for medium success rate', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      const status = adapter.getDeviceStatus('test_device')!;
      status.connected = true;
      status.pollSuccessRate = 0.85;
      
      const quality = (adapter as any).calculateCommunicationQuality(status);
      expect(quality).toBe('degraded');
    });

    it('should calculate poor quality for low success rate', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      const status = adapter.getDeviceStatus('test_device')!;
      status.connected = true;
      status.pollSuccessRate = 0.50;
      
      const quality = (adapter as any).calculateCommunicationQuality(status);
      expect(quality).toBe('poor');
    });
  });

  describe('Poll Scheduling', () => {
    it('should identify enabled devices as due for first poll', () => {
      const config = {
        ...mockConfig,
        devices: [
          {
            name: 'fast_device',
            enabled: true,
            slaveId: 1,
            pollInterval: 100,
            registers: [],
            connection: {
              type: ModbusConnectionType.TCP,
              host: 'localhost',
              port: 502,
              baudRate: 9600,
              dataBits: 8,
              stopBits: 1,
              parity: 'none' as const,
              timeout: 5000,
              retryAttempts: 3,
              retryDelay: 1000
            }
          },
          {
            name: 'slow_device',
            enabled: true,
            slaveId: 2,
            pollInterval: 10000,
            registers: [],
            connection: {
              type: ModbusConnectionType.TCP,
              host: 'localhost',
              port: 502,
              baudRate: 9600,
              dataBits: 8,
              stopBits: 1,
              parity: 'none' as const,
              timeout: 5000,
              retryAttempts: 3,
              retryDelay: 1000
            }
          }
        ]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      // Get devices due for poll (all should be due on first call)
      const devicesDue = (adapter as any).getDevicesDueForPoll();
      
      expect(devicesDue).toHaveLength(2);
      expect(devicesDue.map((d: any) => d.name)).toContain('fast_device');
      expect(devicesDue.map((d: any) => d.name)).toContain('slow_device');
    });

    it('should respect poll intervals', () => {
      const config = {
        ...mockConfig,
        devices: [
          {
            name: 'test_device',
            enabled: true,
            slaveId: 1,
            pollInterval: 10000, // 10 seconds
            registers: [],
            connection: {
              type: ModbusConnectionType.TCP,
              host: 'localhost',
              port: 502,
              baudRate: 9600,
              dataBits: 8,
              stopBits: 1,
              parity: 'none' as const,
              timeout: 5000,
              retryAttempts: 3,
              retryDelay: 1000
            }
          }
        ]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      // Record that device was just polled
      (adapter as any).lastPollTimes.set('test_device', Date.now());
      
      // Immediately after poll, should not be due
      const devicesDue = (adapter as any).getDevicesDueForPoll();
      
      expect(devicesDue).toHaveLength(0);
    });

    it('should return device as due when interval has passed', () => {
      const config = {
        ...mockConfig,
        devices: [
          {
            name: 'test_device',
            enabled: true,
            slaveId: 1,
            pollInterval: 100, // 100ms
            registers: [],
            connection: {
              type: ModbusConnectionType.TCP,
              host: 'localhost',
              port: 502,
              baudRate: 9600,
              dataBits: 8,
              stopBits: 1,
              parity: 'none' as const,
              timeout: 5000,
              retryAttempts: 3,
              retryDelay: 1000
            }
          }
        ]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      // Record that device was polled in the past (200ms ago)
      (adapter as any).lastPollTimes.set('test_device', Date.now() - 200);
      
      // After interval, should be due
      const devicesDue = (adapter as any).getDevicesDueForPoll();
      
      expect(devicesDue).toHaveLength(1);
      expect(devicesDue[0].name).toBe('test_device');
    });
  });

  describe('Metrics', () => {
    it('should get device metrics summary', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      const metrics = adapter.getDeviceMetricsSummary('test_device');
      
      expect(metrics).toBeDefined();
    });

    it('should return null for non-existent device metrics', () => {
      const adapter = new ModbusAdapter(mockConfig, mockLogger);
      
      const metrics = adapter.getDeviceMetricsSummary('non_existent');
      
      expect(metrics).toBeNull();
    });

    it('should get all device metrics', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          slaveId: 1,
          pollInterval: 1000,
          registers: [],
          connection: {
            type: ModbusConnectionType.TCP,
            host: 'localhost',
            port: 502,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: 'none' as const,
            timeout: 5000,
            retryAttempts: 3,
            retryDelay: 1000
          }
        }]
      };

      const adapter = new ModbusAdapter(config, mockLogger);
      
      const allMetrics = adapter.getAllDeviceMetrics();
      
      expect(allMetrics).toBeDefined();
      expect(allMetrics.size).toBe(1);
      expect(allMetrics.has('test_device')).toBe(true);
    });
  });
});
