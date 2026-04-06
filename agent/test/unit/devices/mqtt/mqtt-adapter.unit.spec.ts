/**
 * Unit tests for MQTT Adapter
 * Tests message handling, payload parsing, backpressure, and wildcard matching
 */

import { LocalBrokerMqttAdapter } from '../../../../src/features/adapters/mqtt/adapter';
import { MqttAdapterConfig } from '../../../../src/features/adapters/mqtt/types';
import { parsePayload, coerceType } from '../../../../src/features/adapters/mqtt/payload';

describe('LocalBrokerMqttAdapter', () => {
  let mockLogger: any;
  let mockConfig: MqttAdapterConfig;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };

    mockConfig = {
      broker: {
        host: 'localhost',
        port: 1883,
        username: 'test',
        password: 'test'
      },
      qos: 1,
      reconnect: {
        period: 5000,
        maxAttempts: 10
      },
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

  describe('parsePayload', () => {
    it('should parse plain numeric string', () => {
      const result = parsePayload(Buffer.from('42'));
      expect(result).toBe(42);
    });

    it('should parse JSON with value key', () => {
      const result = parsePayload(
        Buffer.from(JSON.stringify({ value: 23.5 }))
      );
      expect(result).toEqual({ value: 23.5 });
    });

    it('should parse JSON object without value key', () => {
      const result = parsePayload(
        Buffer.from(JSON.stringify({ temperature: 23.5, humidity: 65 }))
      );
      expect(result).toEqual({ temperature: 23.5, humidity: 65 });
    });

    it('should return plain string for non-JSON input', () => {
      const result = parsePayload(Buffer.from('not a number'));
      expect(result).toBe('not a number');
    });

    it('should parse boolean true', () => {
      const result = parsePayload(Buffer.from('true'));
      expect(result).toBe(true);
    });

    it('should parse boolean false', () => {
      const result = parsePayload(Buffer.from('false'));
      expect(result).toBe(false);
    });

    it('should parse numeric 1 as the number 1', () => {
      const result = parsePayload(Buffer.from('1'));
      expect(result).toBe(1);
    });

    it('should parse numeric 0 as the number 0', () => {
      const result = parsePayload(Buffer.from('0'));
      expect(result).toBe(0);
    });

    it('should return string as-is', () => {
      const result = parsePayload(Buffer.from('hello world'));
      expect(result).toBe('hello world');
    });

    it('should return JSON object with value key unchanged', () => {
      const result = parsePayload(
        Buffer.from(JSON.stringify({ value: '42.5' }))
      );
      expect(result).toEqual({ value: '42.5' });
    });

    it('should parse JSON number with surrounding whitespace', () => {
      const result = parsePayload(Buffer.from(' 42 '));
      expect(result).toBe(42);
    });

    it('should parse negative JSON number', () => {
      const result = parsePayload(Buffer.from('-123.45'));
      expect(result).toBe(-123.45);
    });

    it('should return NaN string as plain string (no throw)', () => {
      const result = parsePayload(Buffer.from('NaN'));
      expect(result).toBe('NaN');
    });
  });

  describe('coerceType', () => {
    it('should coerce string to number', () => {
      const result = coerceType('42.5', 'number');
      expect(result).toBe(42.5);
    });

    it('should coerce string to int32', () => {
      const result = coerceType('42', 'int32');
      expect(result).toBe(42);
    });

    it('should coerce string to uint32', () => {
      const result = coerceType('42', 'uint32');
      expect(result).toBe(42);
    });

    it('should coerce string to float32', () => {
      const result = coerceType('42.5', 'float32');
      expect(result).toBe(42.5);
    });

    it('should handle boolean string to boolean', () => {
      expect(coerceType('true', 'boolean')).toBe(true);
      expect(coerceType('false', 'boolean')).toBe(false);
    });

    it('should handle numeric strings to boolean', () => {
      expect(coerceType('1', 'boolean')).toBe(true);
      expect(coerceType('0', 'boolean')).toBe(false);
    });

    it('should return string as-is', () => {
      const result = coerceType('hello', 'string');
      expect(result).toBe('hello');
    });

    it('should throw on NaN coercion', () => {
      expect(() => {
        coerceType('not a number', 'number');
      }).toThrow('Numeric coercion resulted in NaN');
    });
  });

  describe('reconnect backoff', () => {
    it('should keep a fixed reconnect period by default', () => {
      const adapter = new LocalBrokerMqttAdapter(mockConfig, mockLogger) as any;

      expect(adapter.computeReconnectPeriod(1)).toBe(5000);
      expect(adapter.computeReconnectPeriod(4)).toBe(5000);
    });

    it('should compute exponential reconnect periods when enabled', () => {
      const adapter = new LocalBrokerMqttAdapter({
        ...mockConfig,
        reconnect: {
          period: 1000,
          maxAttempts: 10,
          strategy: 'exponential',
          maxPeriod: 8000,
          jitterRatio: 0,
        }
      }, mockLogger) as any;

      expect(adapter.computeReconnectPeriod(1)).toBe(1000);
      expect(adapter.computeReconnectPeriod(2)).toBe(2000);
      expect(adapter.computeReconnectPeriod(3)).toBe(4000);
      expect(adapter.computeReconnectPeriod(4)).toBe(8000);
      expect(adapter.computeReconnectPeriod(5)).toBe(8000);
    });
  });

  describe('handleMessage - Backpressure', () => {
    it('should convert configured metric values into the canonical configured unit', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          metrics: [{
            field: 'temperature',
            metric: 'temperature',
            unit: 'C',
            type: 'number'
          }]
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          ts: 1711843200000,
          temperature: 77,
          units: {
            temperature: 'F'
          }
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);

      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints).toHaveLength(1);
      expect(emittedPoints[0]).toEqual(
        expect.objectContaining({ metric: 'temperature', value: 25, unit: 'C' })
      );
    });

    it('should round converted values to two decimals by default', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          metrics: [{
            field: 'temperature',
            metric: 'temperature',
            unit: 'C',
            type: 'number'
          }]
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          temperature: 72,
          units: {
            temperature: 'F'
          }
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);
      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints[0]).toEqual(
        expect.objectContaining({ metric: 'temperature', value: 22.22, unit: 'C' })
      );
    });

    it('should convert configured temperature values through Kelvin as the base unit', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          metrics: [{
            field: 'temperature',
            metric: 'temperature',
            unit: 'K',
            type: 'number'
          }]
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          temperature: 77,
          units: {
            temperature: 'F'
          }
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);

      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints).toHaveLength(1);
      expect(emittedPoints[0].metric).toBe('temperature');
      expect(emittedPoints[0].unit).toBe('K');
      expect(emittedPoints[0].value).toBeCloseTo(298.15, 6);
    });

    it('should canonicalize degC aliases to C without attempting conversion', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          metrics: [{
            field: 'temperature',
            metric: 'temperature',
            unit: 'degC',
            type: 'number'
          }]
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          temperature: 22,
          units: {
            temperature: 'deg_c'
          }
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);
      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints[0]).toEqual(
        expect.objectContaining({ metric: 'temperature', value: 22, unit: 'C' })
      );
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Unknown unit conversion, storing raw value',
        expect.anything()
      );
    });

    it('should preserve the raw value and incoming unit when canonical conversion is unsupported', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          metrics: [{
            field: 'temperature',
            metric: 'temperature',
            unit: 'kPa',
            type: 'number'
          }]
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          temperature: 77,
          units: {
            temperature: 'F'
          }
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);

      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints).toHaveLength(1);
      expect(emittedPoints[0]).toEqual(
        expect.objectContaining({ metric: 'temperature', value: 77, unit: 'F' })
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Unknown unit conversion, storing raw value',
        expect.objectContaining({ from: 'F', to: 'kPa' })
      );
    });

    it('should log unknown units encountered during canonicalization', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          metrics: [{
            field: 'temperature',
            metric: 'temperature',
            unit: 'celcuis',
            type: 'number'
          }]
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          temperature: 22,
          units: {
            temperature: 'celcuis'
          }
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Unknown unit encountered',
        expect.objectContaining({ unit: 'celcuis' })
      );
    });

    it('should canonicalize psi and atm aliases case-insensitively for autoMetrics defaultUnits', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          autoMetrics: true,
          defaultUnits: {
            pressurePsi: 'PSI',
            pressureAtm: 'ATM'
          }
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          pressurePsi: 100,
          pressurePsi_unit: 'psi',
          pressureAtm: 1,
          pressureAtm_unit: 'atm'
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);
      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ metric: 'pressurePsi', value: 100, unit: 'psi' }),
          expect.objectContaining({ metric: 'pressureAtm', value: 1, unit: 'atm' }),
        ])
      );
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Unknown unit conversion, storing raw value',
        expect.anything()
      );
    });

    it('should treat mm/s as a recognized engineering unit without logging an unknown-unit warning', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          autoMetrics: true
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          vibration: 5.2,
          units: {
            vibration: 'mm/s'
          }
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);
      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints).toHaveLength(1);
      expect(emittedPoints[0]).toEqual(
        expect.objectContaining({ metric: 'vibration', value: 5.2, unit: 'mm/s' })
      );
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Unknown unit encountered',
        expect.objectContaining({ unit: 'mm/s' })
      );
    });

    it('should apply defaultUnits canonical conversion for autoMetrics fields', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          autoMetrics: true,
          defaultUnits: {
            temp: 'C'
          }
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          temp: 72,
          temp_unit: 'F'
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);

      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints).toHaveLength(1);
      expect(emittedPoints[0].metric).toBe('temp');
      expect(emittedPoints[0].unit).toBe('C');
      expect(emittedPoints[0].value).toBe(22.22);
    });

    it('should honor configured precision for autoMetrics defaultPrecisions', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          autoMetrics: true,
          defaultUnits: {
            temp: 'C'
          },
          defaultPrecisions: {
            temp: 1
          }
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          temp: 72,
          temp_unit: 'F'
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);
      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints[0]).toEqual(
        expect.objectContaining({ metric: 'temp', value: 22.2, unit: 'C' })
      );
    });

    it('should convert pressure units through Pa as the base unit for autoMetrics defaultUnits', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          autoMetrics: true,
          defaultUnits: {
            pressure: 'kPa'
          }
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          pressure: 14.5037738,
          pressure_unit: 'psi'
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);

      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints).toHaveLength(1);
      expect(emittedPoints[0].metric).toBe('pressure');
      expect(emittedPoints[0].unit).toBe('kPa');
      expect(emittedPoints[0].value).toBeCloseTo(100, 4);
    });

    it('should emit all primitive fields from a JSON payload when no explicit MQTT metric mapping is configured', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          ts: 1711843200000,
          temperature: 23.5,
          humidity: 65,
          units: {
            temperature: 'C',
            humidity: '%'
          }
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);

      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints).toHaveLength(2);
      expect(emittedPoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ metric: 'temperature', value: 23.5, unit: 'C' }),
          expect.objectContaining({ metric: 'humidity', value: 65, unit: '%' }),
        ])
      );
    });

    it('should leave unit undefined when no unit metadata is present', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number',
          autoMetrics: true
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      (adapter as any).handleMessage(
        'test/topic',
        Buffer.from(JSON.stringify({
          temperature: 23.5
        })),
        false
      );

      expect(dataSpy).toHaveBeenCalledTimes(1);

      const emittedPoints = dataSpy.mock.calls[0][0];
      expect(emittedPoints).toHaveLength(1);
      expect(emittedPoints[0]).toEqual(
        expect.objectContaining({ metric: 'temperature', value: 23.5 })
      );
      expect(emittedPoints[0].unit).toBeUndefined();
    });

    it('should drop messages when queue depth exceeds threshold', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      
      // Fill the emitQueue to exceed MAX_QUEUE_DEPTH (1000)
      (adapter as any).emitQueue = new Array(1000).fill([]);

      // Try to handle message
      (adapter as any).handleMessage('test/topic', Buffer.from('42'), false);

      // Should log warning about dropped message
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('bounded queue limit'),
        expect.anything()
      );

      // Should increment dropped count
      expect((adapter as any).droppedMessageCount).toBeGreaterThan(0);
    });

    it('should process messages when queue depth is below threshold', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);
      
      // Manually populate subscriptions (normally done by start() → subscribe())
      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);
      
      // Queue depth is 0 (below threshold)
      (adapter as any).emitQueueDepth = 0;

      // Handle message
      (adapter as any).handleMessage('test/topic', Buffer.from('42'), false);

      // Should emit data event
      expect(dataSpy).toHaveBeenCalled();
      expect((adapter as any).droppedMessageCount).toBe(0);
    });
  });

  describe('handleMessage - Oversized Payload', () => {
    it('should drop messages exceeding MAX_PAYLOAD_BYTES', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'string'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      
      // Create buffer > 10MB (MAX_PAYLOAD_BYTES)
      const oversizedPayload = Buffer.alloc(11 * 1024 * 1024); // 11MB

      // Handle oversized message
      (adapter as any).handleMessage('test/topic', oversizedPayload, false);

      // Should log warning
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('oversized'),
        expect.anything()
      );

      // Should increment dropped count
      expect((adapter as any).droppedMessageCount).toBeGreaterThan(0);
    });

    it('should process messages within MAX_PAYLOAD_BYTES', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'string'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      // Manually populate subscriptions (normally done by start() → subscribe())
      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      // Create buffer < 10MB
      const normalPayload = Buffer.from('normal size payload');

      // Handle normal message
      (adapter as any).handleMessage('test/topic', normalPayload, false);

      // Should process normally
      expect(dataSpy).toHaveBeenCalled();
      expect((adapter as any).droppedMessageCount).toBe(0);
    });
  });

  describe('findDeviceForTopic - Wildcard Matching', () => {
    it('should match exact topic', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'device/room1/temp',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      
      // Initialize subscriptions
      (adapter as any).subscriptions.set('device/room1/temp', config.devices[0]);

      const device = (adapter as any).findDeviceForTopic('device/room1/temp');
      
      expect(device).toBeDefined();
      expect(device.name).toBe('test_device');
    });

    it('should match single-level wildcard (+)', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'device/+/temp',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      
      // Initialize subscriptions with wildcard
      (adapter as any).subscriptions.set('device/+/temp', config.devices[0]);

      const device = (adapter as any).findDeviceForTopic('device/room1/temp');
      
      expect(device).toBeDefined();
      expect(device.name).toBe('test_device');
    });

    it('should match multi-level wildcard (#)', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'device/#',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      
      // Initialize subscriptions with wildcard
      (adapter as any).subscriptions.set('device/#', config.devices[0]);

      const device = (adapter as any).findDeviceForTopic('device/room1/temp/sensor01');
      
      expect(device).toBeDefined();
      expect(device.name).toBe('test_device');
    });

    it('should return undefined for non-matching topic', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'device/room1/temp',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      
      (adapter as any).subscriptions.set('device/room1/temp', config.devices[0]);

      const device = (adapter as any).findDeviceForTopic('other/topic');
      
      expect(device).toBeUndefined();
    });

    it('should match complex wildcard pattern', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'building/+/floor/+/sensor/#',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      
      (adapter as any).subscriptions.set('building/+/floor/+/sensor/#', config.devices[0]);

      const device = (adapter as any).findDeviceForTopic('building/A/floor/3/sensor/temp/01');
      
      expect(device).toBeDefined();
      expect(device.name).toBe('test_device');
    });
  });

  describe('Basic Adapter Functions', () => {
    it('should create adapter instance', () => {
      const adapter = new LocalBrokerMqttAdapter(mockConfig, mockLogger);
      expect(adapter).toBeDefined();
    });

    it('should return empty device statuses when no devices', () => {
      const adapter = new LocalBrokerMqttAdapter(mockConfig, mockLogger);
      const statuses = adapter.getDeviceStatuses();
      expect(statuses).toEqual([]);
    });

    it('should initialize device statuses', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      
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
          topic: 'test/topic',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);

      const status = adapter.getDeviceStatus('test_device');
      expect(status).toBeDefined();
      expect(status?.deviceName).toBe('test_device');
    });

    it('should return undefined for non-existent device', () => {
      const adapter = new LocalBrokerMqttAdapter(mockConfig, mockLogger);
      const status = adapter.getDeviceStatus('non_existent');
      expect(status).toBeUndefined();
    });
  });

  describe('trackMessageActivity', () => {
    it('should update device status on message', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);

      // Track message activity
      (adapter as any).trackMessageActivity('test_device');

      const status = adapter.getDeviceStatus('test_device');
      expect(status?.lastSeen).toBeInstanceOf(Date);
      expect(status?.lastPoll).toBeInstanceOf(Date);
      expect(status?.registersUpdated).toBe(1);
    });

    it('should increment registersUpdated counter', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);

      // Track multiple messages
      (adapter as any).trackMessageActivity('test_device');
      (adapter as any).trackMessageActivity('test_device');
      (adapter as any).trackMessageActivity('test_device');

      const status = adapter.getDeviceStatus('test_device');
      expect(status?.registersUpdated).toBe(3);
    });
  });

  describe('Message Quality', () => {
    it('should mark retained messages as UNCERTAIN', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      // Manually populate subscriptions (normally done by start() → subscribe())
      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      // Handle retained message (retain = true)
      (adapter as any).handleMessage('test/topic', Buffer.from('42'), true);

      // Should emit data with UNCERTAIN quality
      expect(dataSpy).toHaveBeenCalled();
      const emitted = dataSpy.mock.calls[0][0][0];
      expect(emitted.quality).toBe('UNCERTAIN');
      expect(emitted.qualityCode).toBe('RETAINED_MESSAGE');
    });

    it('should mark fresh messages as GOOD', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      // Manually populate subscriptions (normally done by start() → subscribe())
      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      // Handle fresh message (retain = false)
      (adapter as any).handleMessage('test/topic', Buffer.from('42'), false);

      // Should emit data with GOOD quality
      expect(dataSpy).toHaveBeenCalled();
      const emitted = dataSpy.mock.calls[0][0][0];
      expect(emitted.quality).toBe('GOOD');
    });
  });

  describe('Unconfigured Topics', () => {
    it('should ignore messages for unconfigured topics', () => {
      const adapter = new LocalBrokerMqttAdapter(mockConfig, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      // Handle message for topic not in config
      (adapter as any).handleMessage('unknown/topic', Buffer.from('42'), false);

      // Should NOT emit data event
      expect(dataSpy).not.toHaveBeenCalled();
      
      // Should log debug message
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring message for unconfigured topic')
      );
    });

    it('should handle messages for configured topics', () => {
      const config = {
        ...mockConfig,
        devices: [{
          name: 'test_device',
          enabled: true,
          topic: 'test/topic',
          dataType: 'number'
        }]
      };

      const adapter = new LocalBrokerMqttAdapter(config, mockLogger);
      const dataSpy = jest.fn();
      adapter.on('data', dataSpy);

      // Manually populate subscriptions (normally done by start() → subscribe())
      const device = config.devices[0];
      (adapter as any).subscriptions.set('test/topic', device);

      // Handle message for configured topic
      (adapter as any).handleMessage('test/topic', Buffer.from('42'), false);

      // Should emit data event
      expect(dataSpy).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should throw on JSON without value key when expecting number', () => {
      // JSON object { temp: 42 } without 'value' key, expected type 'number'
      // coerceType receives the object, tries parseFloat(object) → NaN → throw
      const rawValue = parsePayload(Buffer.from(JSON.stringify({ temp: 42 })));
      expect(() => coerceType(rawValue, 'number')).toThrow('Numeric coercion resulted in NaN');
    });

    it('should handle JSON without value key for json dataType', () => {
      // JSON object without 'value' key, but type is 'json' → should stringify
      const rawValue = parsePayload(Buffer.from(JSON.stringify({ temp: 42, humidity: 65 })));
      const result = coerceType(rawValue, 'json');
      expect(result).toBe('{\"temp\":42,\"humidity\":65}');
    });
  });
});
