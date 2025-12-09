/**
 * Target State Config Validator Tests
 * 
 * Tests validation rules for protocol adapter configuration:
 * - Port ranges (1-65535)
 * - Modbus slave IDs (1-247)
 * - IP address formats
 * - Timeout limits
 * - Required fields when features enabled
 */

import { validateTargetStateConfig } from '../validators/target-state-config.validator';

describe('Target State Config Validator', () => {
  describe('Performance Settings', () => {
    it('should accept valid memoryCheckIntervalMs', () => {
      const config = { memoryCheckIntervalMs: 30000 };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject memoryCheckIntervalMs < 1000', () => {
      const config = { memoryCheckIntervalMs: 500 };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'memoryCheckIntervalMs' })
      );
    });

    it('should accept valid memoryThresholdMb', () => {
      const config = { memoryThresholdMb: 30 };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should reject negative memoryThresholdMb', () => {
      const config = { memoryThresholdMb: -5 };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'memoryThresholdMb' })
      );
    });
  });

  describe('Logging Settings', () => {
    it('should accept valid logMaxAge (24 hours)', () => {
      const config = { logMaxAge: 86400 };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should reject logMaxAge < 1 hour', () => {
      const config = { logMaxAge: 1800 }; // 30 minutes
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'logMaxAge' })
      );
    });

    it('should accept valid maxLogFileSize', () => {
      const config = { maxLogFileSize: 52428800 }; // 50MB
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should reject maxLogFileSize < 1KB', () => {
      const config = { maxLogFileSize: 512 };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'maxLogFileSize' })
      );
    });
  });

  describe('Feature Toggles', () => {
    it('should accept boolean feature flags', () => {
      const config = {
        features: {
          enableProtocolAdapters: true,
          enableSensorPublish: false,
          enableFirstBootDiscovery: true
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should reject non-boolean feature flags', () => {
      const config = {
        features: {
          enableProtocolAdapters: 'yes' // Should be boolean
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'features.enableProtocolAdapters' })
      );
    });
  });

  describe('Modbus TCP Configuration', () => {
    it('should accept valid Modbus TCP config', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpHost: '192.168.1.100',
            tcpPort: 502,
            slaveRangeStart: 1,
            slaveRangeEnd: 10,
            timeout: 2000,
            vendor: 'Generic'
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should require tcpHost when Modbus enabled', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpPort: 502
            // tcpHost missing
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.modbus.tcpHost' })
      );
    });

    it('should reject invalid port numbers', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpHost: '192.168.1.100',
            tcpPort: 70000 // Invalid: > 65535
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.modbus.tcpPort' })
      );
    });

    it('should reject invalid Modbus slave IDs', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpHost: '192.168.1.100',
            slaveRangeStart: 0, // Invalid: < 1
            slaveRangeEnd: 250 // Invalid: > 247
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it('should reject inverted slave range', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpHost: '192.168.1.100',
            slaveRangeStart: 10,
            slaveRangeEnd: 1 // Start > End
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.modbus.slaveRange' })
      );
    });

    it('should accept valid RTU configuration', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpHost: '192.168.1.100',
            rtuPort: '/dev/ttyUSB0',
            rtuBaudRate: 9600,
            rtuParity: 'none',
            rtuDataBits: 8,
            rtuStopBits: 1
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should reject invalid RTU baud rate', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpHost: '192.168.1.100',
            rtuBaudRate: 1200 // Not in valid list
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.modbus.rtuBaudRate' })
      );
    });

    it('should reject invalid RTU parity', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpHost: '192.168.1.100',
            rtuParity: 'mark' // Not in valid list
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.modbus.rtuParity' })
      );
    });
  });

  describe('OPC-UA Configuration', () => {
    it('should accept valid OPC-UA config', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          opcua: {
            enabled: true,
            discoveryUrls: [
              'opc.tcp://192.168.1.50:4840',
              'http://192.168.1.51:4840'
            ]
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should require discoveryUrls when OPC-UA enabled', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          opcua: {
            enabled: true
            // discoveryUrls missing
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.opcua.discoveryUrls' })
      );
    });

    it('should reject empty discoveryUrls array', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          opcua: {
            enabled: true,
            discoveryUrls: []
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.opcua.discoveryUrls' })
      );
    });

    it('should reject invalid OPC-UA URLs', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          opcua: {
            enabled: true,
            discoveryUrls: [
              'not-a-valid-url',
              'ftp://192.168.1.50:4840' // Wrong protocol
            ]
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('SNMP Configuration', () => {
    it('should accept valid SNMP config with CIDR notation', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          snmp: {
            enabled: true,
            ipRanges: ['192.168.1.0/24', '10.0.0.0/8'],
            port: 161
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should accept valid SNMP config with IP ranges', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          snmp: {
            enabled: true,
            ipRanges: ['192.168.1.1-192.168.1.254'],
            port: 161
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should require ipRanges when SNMP enabled', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          snmp: {
            enabled: true,
            port: 161
            // ipRanges missing
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.snmp.ipRanges' })
      );
    });

    it('should reject empty ipRanges array', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          snmp: {
            enabled: true,
            ipRanges: []
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.snmp.ipRanges' })
      );
    });

    it('should reject invalid IP ranges', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          snmp: {
            enabled: true,
            ipRanges: [
              '192.168.1.999/24', // Invalid IP
              '10.0.0.0/33', // Invalid CIDR
              'not-an-ip'
            ]
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    it('should reject invalid SNMP port', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          snmp: {
            enabled: true,
            ipRanges: ['192.168.1.0/24'],
            port: 0 // Invalid
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.snmp.port' })
      );
    });
  });

  describe('Conditional Validation', () => {
    it('should skip required field validation when protocol adapters disabled', () => {
      const config = {
        features: { enableProtocolAdapters: false },
        protocolAdapters: {
          modbus: {
            enabled: true
            // tcpHost missing, but adapters globally disabled
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should skip required field validation when individual adapter disabled', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: false
            // tcpHost missing, but Modbus disabled
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });
  });

  describe('Timeout Validation', () => {
    it('should accept reasonable timeout values', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpHost: '192.168.1.100',
            timeout: 5000 // 5 seconds
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should reject timeout > 5 minutes', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpHost: '192.168.1.100',
            timeout: 600000 // 10 minutes - too long
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.modbus.timeout' })
      );
    });

    it('should reject negative timeout', () => {
      const config = {
        features: { enableProtocolAdapters: true },
        protocolAdapters: {
          modbus: {
            enabled: true,
            tcpHost: '192.168.1.100',
            timeout: -1000
          }
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'protocolAdapters.modbus.timeout' })
      );
    });
  });

  describe('Empty/Null Config', () => {
    it('should accept undefined config', () => {
      const result = validateTargetStateConfig(undefined);
      expect(result.valid).toBe(true);
    });

    it('should accept null config', () => {
      const result = validateTargetStateConfig(null);
      expect(result.valid).toBe(true);
    });

    it('should accept empty config object', () => {
      const result = validateTargetStateConfig({});
      expect(result.valid).toBe(true);
    });
  });

  describe('Logging Batch Configuration', () => {
    it('should accept valid logBatchSize', () => {
      const config = {
        logging: {
          logBatchSize: 100
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject logBatchSize < 1', () => {
      const config = {
        logging: {
          logBatchSize: 0
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'logging.logBatchSize' })
      );
    });

    it('should reject logBatchSize > 1000', () => {
      const config = {
        logging: {
          logBatchSize: 1500
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'logging.logBatchSize' })
      );
    });

    it('should accept valid logFlushIntervalMs (30 seconds)', () => {
      const config = {
        logging: {
          logFlushIntervalMs: 30000
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject logFlushIntervalMs < 1000 (1 second)', () => {
      const config = {
        logging: {
          logFlushIntervalMs: 500
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'logging.logFlushIntervalMs' })
      );
    });

    it('should reject logFlushIntervalMs > 300000 (5 minutes)', () => {
      const config = {
        logging: {
          logFlushIntervalMs: 600000
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: 'logging.logFlushIntervalMs' })
      );
    });

    it('should accept both batch settings together', () => {
      const config = {
        logging: {
          logBatchSize: 500,
          logFlushIntervalMs: 60000,
          enableCompression: true
        }
      };
      const result = validateTargetStateConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
