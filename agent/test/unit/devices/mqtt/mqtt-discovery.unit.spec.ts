/**
 * Unit tests for MQTT Discovery Plugin
 * Tests core discovery logic without real broker dependencies
 */

import { EventEmitter } from 'events';
import { LocalBrokerMqttDiscoveryPlugin } from '../../../../src/features/adapters/mqtt/discovery';
import { LogComponents } from '../../../../src/logging/types';

/**
 * Fake MQTT client for testing
 * Extends EventEmitter to simulate mqtt.js event-based API
 */
class FakeMqttClient extends EventEmitter {
  subscribe = jest.fn((topic: string | string[], opts: any, cb?: (err: Error | null) => void) => {
    // Simulate successful subscription
    if (cb) cb(null);
    return this;
  });

  end = jest.fn((force?: boolean, cb?: () => void) => {
    if (cb) cb();
    return this;
  });

  removeAllListeners = jest.fn(() => {
    super.removeAllListeners();
    return this;
  });
}

describe('LocalBrokerMqttDiscoveryPlugin', () => {
  let mockLogger: any;
  let fakeClient: FakeMqttClient;
  let mockFactory: jest.Mock;
  let plugin: LocalBrokerMqttDiscoveryPlugin;

  beforeEach(() => {
    // Mock logger
    mockLogger = {
      debugSync: jest.fn(),
      infoSync: jest.fn(),
      warnSync: jest.fn(),
      errorSync: jest.fn()
    };

    // Create fake MQTT client
    fakeClient = new FakeMqttClient();

    // Mock factory that returns fake client
    mockFactory = jest.fn().mockReturnValue(fakeClient);

    // Create plugin with mocked dependencies
    plugin = new LocalBrokerMqttDiscoveryPlugin(mockLogger, mockFactory);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('inferDataType', () => {
    it('should detect number from plain numeric string', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      // Access private method using bracket notation
      const result = (plugin as any).inferDataType('42');
      expect(result).toBe('number');
    });

    it('should detect number from decimal string', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('12.5');
      expect(result).toBe('number');
    });

    it('should detect number with whitespace', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType(' 42 ');
      expect(result).toBe('number');
    });

    it('should detect negative numbers', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('-123.45');
      expect(result).toBe('number');
    });

    it('should detect boolean true', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('true');
      expect(result).toBe('boolean');
    });

    it('should detect boolean false', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('false');
      expect(result).toBe('boolean');
    });

    it('should detect boolean case-insensitive', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      expect((plugin as any).inferDataType('TRUE')).toBe('boolean');
      expect((plugin as any).inferDataType('False')).toBe('boolean');
    });

    it('should treat NaN as string', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('NaN');
      expect(result).toBe('string');
    });

    it('should treat Infinity as string', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('Infinity');
      expect(result).toBe('string');
    });

    it('should treat leading zeros as number', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      // Based on regex ^-?\d+(\.\d+)?$ this should match
      const result = (plugin as any).inferDataType('00123');
      expect(result).toBe('number');
    });

    it('should detect JSON object', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('{"a":1}');
      expect(result).toBe('json');
    });

    it('should detect JSON array', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('[1,2,3]');
      expect(result).toBe('json');
    });

    it('should detect JSON number', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('42');
      expect(result).toBe('number'); // Valid JSON number
    });

    it('should detect JSON boolean', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('true');
      expect(result).toBe('boolean'); // Valid JSON boolean
    });

    it('should treat plain text as string', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('hello world');
      expect(result).toBe('string');
    });

    it('should treat empty string as string', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = (plugin as any).inferDataType('');
      expect(result).toBe('string');
    });
  });

  describe('handleMessage', () => {
    it('should track first message received', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', '42', false);

      const validation = validatedTopics.get('test/topic');
      expect(validation).toBeDefined();
      expect(validation.messagesReceived).toBe(1);
      expect(validation.firstSeen).toBeInstanceOf(Date);
      expect(validation.firstPayload).toBe('42');
    });

    it('should detect retained message', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', '42', true);

      const validation = validatedTopics.get('test/topic');
      expect(validation.hasRetained).toBe(true);
      expect(validation.retainedMessagesReceived).toBe(1);
      expect(validation.hasLive).toBe(false);
    });

    it('should detect live message', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', '42', false);

      const validation = validatedTopics.get('test/topic');
      expect(validation.hasLive).toBe(true);
      expect(validation.hasRetained).toBe(false);
      expect(validation.retainedMessagesReceived).toBe(0);
    });

    it('should increment message count', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', '1', false);
      (plugin as any).handleMessage('test/topic', '2', false);
      (plugin as any).handleMessage('test/topic', '3', false);

      const validation = validatedTopics.get('test/topic');
      expect(validation.messagesReceived).toBe(3);
    });

    it('should update lastSeen on each message', () => {
      jest.useFakeTimers();
      try {
        const plugin = new LocalBrokerMqttDiscoveryPlugin();
        const validatedTopics = (plugin as any).validatedTopics;

        (plugin as any).handleMessage('test/topic', '1', false);
        const firstSeen = validatedTopics.get('test/topic').lastSeen;

        // Wait a bit
        jest.advanceTimersByTime(100);

        (plugin as any).handleMessage('test/topic', '2', false);
        const secondSeen = validatedTopics.get('test/topic').lastSeen;

        expect(secondSeen).not.toEqual(firstSeen);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should handle both retained and live messages', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', '1', true);  // Retained
      (plugin as any).handleMessage('test/topic', '2', false); // Live

      const validation = validatedTopics.get('test/topic');
      expect(validation.hasRetained).toBe(true);
      expect(validation.hasLive).toBe(true);
      expect(validation.retainedMessagesReceived).toBe(1);
      expect(validation.messagesReceived).toBe(2);
    });

    it('should preserve first payload across messages', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validatedTopics = (plugin as any).validatedTopics;

      (plugin as any).handleMessage('test/topic', 'first', false);
      (plugin as any).handleMessage('test/topic', 'second', false);
      (plugin as any).handleMessage('test/topic', 'third', false);

      const validation = validatedTopics.get('test/topic');
      expect(validation.firstPayload).toBe('first');
      expect(validation.messagesReceived).toBe(3);
    });
  });

  describe('convertToDevices', () => {
    it('should generate stable fingerprint', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validations = [
        {
          topic: 'device/sensor01/temperature',
          messagesReceived: 5,
          retainedMessagesReceived: 0,
          firstPayload: '23.5',
          firstSeen: new Date(),
          lastSeen: new Date(),
          hasLive: true,
          hasRetained: false
        }
      ];

      const devices = (plugin as any).convertToDevices(validations);
      
      expect(devices).toHaveLength(1);
      expect(devices[0].fingerprint).toBeDefined();
      expect(devices[0].fingerprint).toHaveLength(32);
      
      // Fingerprint should be stable for same topic
      const devices2 = (plugin as any).convertToDevices(validations);
      expect(devices2[0].fingerprint).toBe(devices[0].fingerprint);
    });

    it('should truncate long topic names', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const longTopic = 'a/'.repeat(50) + 'temperature'; // Very long topic
      const validations = [
        {
          topic: longTopic,
          messagesReceived: 1,
          retainedMessagesReceived: 0,
          firstPayload: '42',
          firstSeen: new Date(),
          lastSeen: new Date(),
          hasLive: true,
          hasRetained: false
        }
      ];

      const devices = (plugin as any).convertToDevices(validations);
      
      // Name should start with 'mqtt_' and be truncated
      expect(devices[0].name).toMatch(/^mqtt_\.\.\./);
      expect(devices[0].name.length).toBeLessThanOrEqual(63); // mqtt_ + ... + 57 chars
    });

    it('should infer data type from first payload', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validations = [
        {
          topic: 'test/number',
          messagesReceived: 1,
          retainedMessagesReceived: 0,
          firstPayload: '42.5',
          firstSeen: new Date(),
          lastSeen: new Date(),
          hasLive: true,
          hasRetained: false
        },
        {
          topic: 'test/boolean',
          messagesReceived: 1,
          retainedMessagesReceived: 0,
          firstPayload: 'true',
          firstSeen: new Date(),
          lastSeen: new Date(),
          hasLive: true,
          hasRetained: false
        },
        {
          topic: 'test/string',
          messagesReceived: 1,
          retainedMessagesReceived: 0,
          firstPayload: 'hello',
          firstSeen: new Date(),
          lastSeen: new Date(),
          hasLive: true,
          hasRetained: false
        }
      ];

      const devices = (plugin as any).convertToDevices(validations);
      
      expect(devices[0].connection.dataType).toBe('number');
      expect(devices[1].connection.dataType).toBe('boolean');
      expect(devices[2].connection.dataType).toBe('string');
    });

    it('should set confidence to high for validated topics', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validations = [
        {
          topic: 'test/topic',
          messagesReceived: 10,
          retainedMessagesReceived: 0,
          firstPayload: '42',
          firstSeen: new Date(),
          lastSeen: new Date(),
          hasLive: true,
          hasRetained: false
        }
      ];

      const devices = (plugin as any).convertToDevices(validations);
      
      expect(devices[0].confidence).toBe('high');
    });

    it('should set validated to false', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validations = [
        {
          topic: 'test/topic',
          messagesReceived: 1,
          retainedMessagesReceived: 0,
          firstPayload: '42',
          firstSeen: new Date(),
          lastSeen: new Date(),
          hasLive: true,
          hasRetained: false
        }
      ];

      const devices = (plugin as any).convertToDevices(validations);
      
      expect(devices[0].validated).toBe(false);
    });

    it('should set protocol to mqtt', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const validations = [
        {
          topic: 'test/topic',
          messagesReceived: 1,
          retainedMessagesReceived: 0,
          firstPayload: '42',
          firstSeen: new Date(),
          lastSeen: new Date(),
          hasLive: true,
          hasRetained: false
        }
      ];

      const devices = (plugin as any).convertToDevices(validations);
      
      expect(devices[0].protocol).toBe('mqtt');
    });

    it('should include discoveredAt timestamp', () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const now = new Date();
      const validations = [
        {
          topic: 'test/topic',
          messagesReceived: 1,
          retainedMessagesReceived: 0,
          firstPayload: '42',
          firstSeen: now,
          lastSeen: now,
          hasLive: true,
          hasRetained: false
        }
      ];

      const devices = (plugin as any).convertToDevices(validations);
      
      expect(devices[0].discoveredAt).toBeDefined();
      expect(new Date(devices[0].discoveredAt).getTime()).toBe(now.getTime());
    });
  });

  describe('discover', () => {
    it('should return empty array when no topics provided', async () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin(mockLogger, mockFactory);
      
      const result = await plugin.discover({ 
        brokerUrl: 'mqtt://test:1883',
        topics: []
      });

      expect(result).toEqual([]);
      expect(mockLogger.warnSync).toHaveBeenCalledWith(
        expect.stringContaining('No topics provided'),
        expect.any(Object)
      );
    });

    it('should use mqtt factory to create client', async () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin(mockLogger, mockFactory);

      // Simulate connection immediately
      setTimeout(() => {
        fakeClient.emit('connect');
      }, 10);

      const promise = plugin.discover({
        brokerUrl: 'mqtt://test:1883',
        topics: ['test/topic'],
        samplingDurationMs: 100
      });

      // Simulate message after connection
      setTimeout(() => {
        fakeClient.emit('message', 'test/topic', Buffer.from('42'), { retain: false });
      }, 20);

      await promise;

      expect(mockFactory).toHaveBeenCalledWith(
        'mqtt://test:1883',
        expect.objectContaining({
          clientId: expect.stringContaining('iotistic-discovery-'),
          clean: true,
          reconnectPeriod: 0
        })
      );
    });

    it('should pass authentication options to client', async () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin(mockLogger, mockFactory);

      setTimeout(() => fakeClient.emit('connect'), 10);

      const promise = plugin.discover({
        brokerUrl: 'mqtt://test:1883',
        topics: ['test/topic'],
        username: 'user',
        password: 'pass',
        samplingDurationMs: 100
      });

      setTimeout(() => {
        fakeClient.emit('message', 'test/topic', Buffer.from('42'), { retain: false });
      }, 20);

      await promise;

      expect(mockFactory).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          username: 'user',
          password: 'pass'
        })
      );
    });
  });

  describe('isAvailable', () => {
    it('should return true (MQTT always available)', async () => {
      const plugin = new LocalBrokerMqttDiscoveryPlugin();
      const result = await plugin.isAvailable();
      expect(result).toBe(true);
    });
  });
});
