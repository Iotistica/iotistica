/**
 * Target State Config Validator
 * 
 * Validates the config object structure for device target state updates.
 * Ensures protocol adapter settings meet constraints:
 * - Port ranges: 1-65535
 * - Modbus slave IDs: 1-247
 * - IP address formats
 * - Reasonable timeout limits
 * - Required fields when features enabled
 */

interface ValidationError {
  field: string;
  message: string;
  value?: any;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validate IP address format (IPv4 or IPv6)
 */
function isValidIpAddress(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;

  // IPv4 pattern
  const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  
  // IPv6 pattern (simplified - covers most cases)
  const ipv6Pattern = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
  
  return ipv4Pattern.test(ip) || ipv6Pattern.test(ip);
}

/**
 * Validate IP range format (CIDR notation or range)
 * Examples: "192.168.1.0/24", "10.0.0.1-10.0.0.254"
 */
function isValidIpRange(range: string): boolean {
  if (!range || typeof range !== 'string') return false;

  // CIDR notation
  const cidrPattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\/(?:[0-9]|[1-2][0-9]|3[0-2])$/;
  if (cidrPattern.test(range)) return true;

  // IP range (start-end)
  const rangeParts = range.split('-');
  if (rangeParts.length === 2) {
    return isValidIpAddress(rangeParts[0].trim()) && isValidIpAddress(rangeParts[1].trim());
  }

  // Single IP address
  return isValidIpAddress(range);
}

/**
 * Validate port number (1-65535)
 */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Validate Modbus slave ID (1-247)
 */
function isValidModbusSlave(slaveId: number): boolean {
  return Number.isInteger(slaveId) && slaveId >= 1 && slaveId <= 247;
}

/**
 * Validate timeout value (must be positive, reasonable max 5 minutes)
 */
function isValidTimeout(timeout: number): boolean {
  return Number.isInteger(timeout) && timeout > 0 && timeout <= 300000; // Max 5 minutes
}

/**
 * Validate URL format
 */
function isValidUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'opc.tcp:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Validate target state config object
 */
export function validateTargetStateConfig(config: any): ValidationResult {
  const errors: ValidationError[] = [];

  if (!config || typeof config !== 'object') {
    return { valid: true, errors: [] }; // Config is optional
  }

  // ==================== Performance Settings ====================
  if (config.memoryCheckIntervalMs !== undefined) {
    if (!Number.isInteger(config.memoryCheckIntervalMs) || config.memoryCheckIntervalMs < 1000) {
      errors.push({
        field: 'memoryCheckIntervalMs',
        message: 'Must be an integer >= 1000 (1 second minimum)',
        value: config.memoryCheckIntervalMs
      });
    }
  }

  if (config.memoryThresholdMb !== undefined) {
    if (!Number.isInteger(config.memoryThresholdMb) || config.memoryThresholdMb < 1) {
      errors.push({
        field: 'memoryThresholdMb',
        message: 'Must be a positive integer (megabytes)',
        value: config.memoryThresholdMb
      });
    }
  }

  // ==================== Logging Settings ====================
  if (config.logMaxAge !== undefined) {
    if (!Number.isInteger(config.logMaxAge) || config.logMaxAge < 3600) {
      errors.push({
        field: 'logMaxAge',
        message: 'Must be an integer >= 3600 (1 hour minimum)',
        value: config.logMaxAge
      });
    }
  }

  if (config.maxLogFileSize !== undefined) {
    if (!Number.isInteger(config.maxLogFileSize) || config.maxLogFileSize < 1024) {
      errors.push({
        field: 'maxLogFileSize',
        message: 'Must be an integer >= 1024 (1KB minimum)',
        value: config.maxLogFileSize
      });
    }
  }

  if (config.maxLogs !== undefined) {
    if (!Number.isInteger(config.maxLogs) || config.maxLogs < 1) {
      errors.push({
        field: 'maxLogs',
        message: 'Must be a positive integer',
        value: config.maxLogs
      });
    }
  }

  // ==================== Feature Toggles ====================
  const features = config.features || {};

  if (features.enableSensorPublish !== undefined && typeof features.enableSensorPublish !== 'boolean') {
    errors.push({
      field: 'features.enableSensorPublish',
      message: 'Must be a boolean',
      value: features.enableSensorPublish
    });
  }


  // ==================== Logging Features ====================
  const logging = config.logging || {};

  if (logging.enableFilePersistence !== undefined && typeof logging.enableFilePersistence !== 'boolean') {
    errors.push({
      field: 'logging.enableFilePersistence',
      message: 'Must be a boolean',
      value: logging.enableFilePersistence
    });
  }

  if (logging.enableCompression !== undefined && typeof logging.enableCompression !== 'boolean') {
    errors.push({
      field: 'logging.enableCompression',
      message: 'Must be a boolean',
      value: logging.enableCompression
    });
  }

  if (logging.logBatchSize !== undefined) {
    if (!Number.isInteger(logging.logBatchSize) || logging.logBatchSize < 1 || logging.logBatchSize > 1000) {
      errors.push({
        field: 'logging.logBatchSize',
        message: 'Must be an integer between 1 and 1000',
        value: logging.logBatchSize
      });
    }
  }

  if (logging.logFlushIntervalMs !== undefined) {
    if (!Number.isInteger(logging.logFlushIntervalMs) || logging.logFlushIntervalMs < 1000 || logging.logFlushIntervalMs > 300000) {
      errors.push({
        field: 'logging.logFlushIntervalMs',
        message: 'Must be an integer between 1000 (1 second) and 300000 (5 minutes)',
        value: logging.logFlushIntervalMs
      });
    }
  }

  // ==================== Protocol Configuration ====================
  // Check protocols section (primary) and protocolAdapters (legacy fallback)
  const protocols = config.protocols || {};
  const protocolAdapters = config.protocolAdapters || {};

  // --- Modbus Configuration ---
  // Priority: protocols.modbus (primary) → protocolAdapters.modbus (legacy)
  const modbus = { ...(protocolAdapters.modbus || {}), ...(protocols.modbus || {}) };
  
  if (modbus.enabled !== undefined && typeof modbus.enabled !== 'boolean') {
    errors.push({
      field: 'protocols.modbus.enabled',
      message: 'Must be a boolean',
      value: modbus.enabled
    });
  }

  if (modbus.enabled === true) {
    // Required fields when Modbus is enabled
    if (modbus.tcpHost !== undefined && (!modbus.tcpHost || typeof modbus.tcpHost !== 'string')) {
      errors.push({
        field: 'protocols.modbus.tcpHost',
        message: 'Must be a non-empty string (IP address or hostname)',
        value: modbus.tcpHost
      });
    }

    if (modbus.tcpPort !== undefined) {
      if (!isValidPort(modbus.tcpPort)) {
        errors.push({
          field: 'protocols.modbus.tcpPort',
          message: 'Must be a valid port number (1-65535)',
          value: modbus.tcpPort
        });
      }
    }

    if (modbus.slaveRangeStart !== undefined) {
      if (!isValidModbusSlave(modbus.slaveRangeStart)) {
        errors.push({
          field: 'protocols.modbus.slaveRangeStart',
          message: 'Must be a valid Modbus slave ID (1-247)',
          value: modbus.slaveRangeStart
        });
      }
    }

    if (modbus.slaveRangeEnd !== undefined) {
      if (!isValidModbusSlave(modbus.slaveRangeEnd)) {
        errors.push({
          field: 'protocols.modbus.slaveRangeEnd',
          message: 'Must be a valid Modbus slave ID (1-247)',
          value: modbus.slaveRangeEnd
        });
      }
    }

    // Validate range order
    if (modbus.slaveRangeStart !== undefined && modbus.slaveRangeEnd !== undefined) {
      if (modbus.slaveRangeStart > modbus.slaveRangeEnd) {
        errors.push({
          field: 'protocols.modbus.slaveRange',
          message: 'slaveRangeStart must be <= slaveRangeEnd',
          value: { start: modbus.slaveRangeStart, end: modbus.slaveRangeEnd }
        });
      }
    }

    if (modbus.timeout !== undefined) {
      if (!isValidTimeout(modbus.timeout)) {
        errors.push({
          field: 'protocols.modbus.timeout',
          message: 'Must be a positive integer <= 300000ms (5 minutes)',
          value: modbus.timeout
        });
      }
    }

    if (modbus.profile !== undefined && typeof modbus.profile !== 'string') {
      errors.push({
        field: 'protocols.modbus.profile',
        message: 'Must be a string',
        value: modbus.profile
      });
    }

    // RTU Configuration (optional)
    if (modbus.rtuPort !== undefined && typeof modbus.rtuPort !== 'string') {
      errors.push({
        field: 'protocols.modbus.serialPort',
        message: 'Must be a string (serial port path)',
        value: modbus.rtuPort
      });
    }

    if (modbus.rtuBaudRate !== undefined) {
      const validBaudRates = [9600, 19200, 38400, 57600, 115200];
      if (!validBaudRates.includes(modbus.rtuBaudRate)) {
        errors.push({
          field: 'protocols.modbus.baudRate',
          message: `Must be one of: ${validBaudRates.join(', ')}`,
          value: modbus.rtuBaudRate
        });
      }
    }

    if (modbus.rtuParity !== undefined) {
      const validParity = ['none', 'even', 'odd'];
      if (!validParity.includes(modbus.rtuParity)) {
        errors.push({
          field: 'protocols.modbus.parity',
          message: `Must be one of: ${validParity.join(', ')}`,
          value: modbus.rtuParity
        });
      }
    }

    if (modbus.rtuDataBits !== undefined) {
      const validDataBits = [7, 8];
      if (!validDataBits.includes(modbus.rtuDataBits)) {
        errors.push({
          field: 'protocols.modbus.dataBits',
          message: `Must be one of: ${validDataBits.join(', ')}`,
          value: modbus.rtuDataBits
        });
      }
    }

    if (modbus.rtuStopBits !== undefined) {
      const validStopBits = [1, 2];
      if (!validStopBits.includes(modbus.rtuStopBits)) {
        errors.push({
          field: 'protocols.modbus.stopBits',
          message: `Must be one of: ${validStopBits.join(', ')}`,
          value: modbus.rtuStopBits
        });
      }
    }
  }

  // --- OPC-UA Configuration ---
  const opcua = { ...(protocolAdapters.opcua || {}), ...(protocols.opcua || {}) };

  if (opcua.enabled !== undefined && typeof opcua.enabled !== 'boolean') {
    errors.push({
      field: 'protocols.opcua.enabled',
      message: 'Must be a boolean',
      value: opcua.enabled
    });
  }

  if (opcua.enabled === true) {
    if (opcua.discoveryUrls !== undefined) {
      if (!Array.isArray(opcua.discoveryUrls)) {
        errors.push({
          field: 'protocols.opcua.discoveryUrls',
          message: 'Must be an array of URLs',
          value: opcua.discoveryUrls
        });
      } else {
        opcua.discoveryUrls.forEach((url: any, index: number) => {
          if (!isValidUrl(url)) {
            errors.push({
              field: `protocols.opcua.discoveryUrls[${index}]`,
              message: 'Must be a valid URL (opc.tcp://, http://, or https://)',
              value: url
            });
          }
        });

        if (opcua.discoveryUrls.length === 0) {
          errors.push({
            field: 'protocols.opcua.discoveryUrls',
            message: 'Required when OPC-UA is enabled (at least one URL)',
            value: opcua.discoveryUrls
          });
        }
      }
    } else {
      errors.push({
        field: 'protocols.opcua.discoveryUrls',
        message: 'Required when OPC-UA is enabled',
        value: undefined
      });
    }
  }

  // --- SNMP Configuration ---
  const snmp = { ...(protocolAdapters.snmp || {}), ...(protocols.snmp || {}) };

  if (snmp.enabled !== undefined && typeof snmp.enabled !== 'boolean') {
    errors.push({
      field: 'protocols.snmp.enabled',
      message: 'Must be a boolean',
      value: snmp.enabled
    });
  }

  if (snmp.enabled === true) {
    if (snmp.ipRanges !== undefined) {
      if (!Array.isArray(snmp.ipRanges)) {
        errors.push({
          field: 'protocols.snmp.ipRanges',
          message: 'Must be an array of IP ranges (CIDR or range notation)',
          value: snmp.ipRanges
        });
      } else {
        snmp.ipRanges.forEach((range: any, index: number) => {
          if (typeof range !== 'string' || !isValidIpRange(range)) {
            errors.push({
              field: `protocols.snmp.ipRanges[${index}]`,
              message: 'Must be a valid IP range (e.g., "192.168.1.0/24" or "10.0.0.1-10.0.0.254")',
              value: range
            });
          }
        });

        if (snmp.ipRanges.length === 0) {
          errors.push({
            field: 'protocols.snmp.ipRanges',
            message: 'Required when SNMP is enabled (at least one IP range)',
            value: snmp.ipRanges
          });
        }
      }
    } else {
      errors.push({
        field: 'protocols.snmp.ipRanges',
        message: 'Required when SNMP is enabled',
        value: undefined
      });
    }

    if (snmp.port !== undefined) {
      if (!isValidPort(snmp.port)) {
        errors.push({
          field: 'protocols.snmp.port',
          message: 'Must be a valid port number (1-65535)',
          value: snmp.port
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Express middleware for validating target state config
 */
export function validateTargetStateConfigMiddleware(req: any, res: any, next: any) {
  const { config } = req.body;

  if (!config) {
    // Config is optional, continue
    return next();
  }

  const validation = validateTargetStateConfig(config);

  if (!validation.valid) {
    return res.status(400).json({
      error: 'Invalid target state config',
      message: 'Config validation failed',
      errors: validation.errors
    });
  }

  next();
}
