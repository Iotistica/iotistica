import ModbusRTU from 'modbus-serial';
import {
  ModbusDevice,
  ModbusConnectionType,
  ModbusFunctionCode,
  ModbusDataType,
  ByteOrder,
  Endianness
} from './types';
import { SensorDataPoint, Logger } from '../types.js';

/**
 * Modbus Client wrapper that handles different connection types and data reading
 */
export class ModbusClient {
  private client: ModbusRTU;
  private device: ModbusDevice;
  private logger: Logger;
  private connected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private keepAliveTimer?: NodeJS.Timeout;
  
  // Concurrency control: modbus-serial does NOT support concurrent requests
  // Multiple simultaneous reads will corrupt frames and return bad data
  private queue: Promise<any> = Promise.resolve();
  
  // Exponential backoff for reconnection attempts
  private currentRetryDelay: number;
  private readonly MIN_RETRY_DELAY = 5000;   // Start at 5s
  private readonly MAX_RETRY_DELAY = 60000;  // Cap at 60s
  private consecutiveFailures = 0;
  
  // Health tracking
  private lastSuccessfulRead = Date.now(); // Last successful register read
  private lastConnectionSuccess = Date.now(); // Last successful connection
  
  // Keep-alive settings (TCP only)
  private readonly KEEP_ALIVE_INTERVAL = 30000; // 30 seconds

  constructor(device: ModbusDevice, logger: Logger) {
    this.device = device;
    this.logger = logger;
    this.client = new ModbusRTU();
    this.currentRetryDelay = this.MIN_RETRY_DELAY;
    this.setupErrorHandlers();
  }
  
  /**
   * Mutex lock for serializing Modbus requests
   * CRITICAL: modbus-serial library does not support concurrent requests
   * Without this, concurrent reads will corrupt frames and return bad data
   */
  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {}); // Prevent unhandled rejection
    return result;
  }
  
  /**
   * Wrap a promise with an external timeout
   * Needed because modbus-serial sometimes hangs indefinitely on serial port issues
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    let timeoutHandle: NodeJS.Timeout;
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Operation '${operation}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    
    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timeoutHandle!);
      return result;
    } catch (error) {
      clearTimeout(timeoutHandle!);
      throw error;
    }
  }

  /**
   * Connect to the Modbus device
   */
  async connect(): Promise<void> {
    try {
      this.logger.debug(`Connecting to Modbus device: ${this.device.name}`);
      
      const { connection } = this.device;
      
      switch (connection.type) {
        case ModbusConnectionType.TCP:
          if (!connection.host) {
            throw new Error('TCP connection requires host');
          }
          await this.client.connectTCP(connection.host, { port: connection.port });
          break;
          
        case ModbusConnectionType.RTU:
          if (!connection.serialPort) {
            throw new Error('RTU connection requires serialPort');
          }
          await this.client.connectRTUBuffered(connection.serialPort, {
            baudRate: connection.baudRate,
            dataBits: connection.dataBits,
            stopBits: connection.stopBits,
            parity: connection.parity
          });
          break;
          
        case ModbusConnectionType.ASCII:
          if (!connection.serialPort) {
            throw new Error('ASCII connection requires serialPort');
          }
          await this.client.connectAsciiSerial(connection.serialPort, {
            baudRate: connection.baudRate,
            dataBits: connection.dataBits,
            stopBits: connection.stopBits,
            parity: connection.parity
          });
          break;
          
        default:
          throw new Error(`Unsupported connection type: ${connection.type}`);
      }

      // Set slave ID
      this.client.setID(this.device.slaveId);
      
      // Set timeout
      this.client.setTimeout(connection.timeout);
      
      this.connected = true;
      
      // Reset backoff on successful connection
      this.currentRetryDelay = this.MIN_RETRY_DELAY;
      this.consecutiveFailures = 0;
      this.lastConnectionSuccess = Date.now();
      
      // Start keep-alive for TCP connections
      if (this.device.connection.type === ModbusConnectionType.TCP) {
        this.startKeepAlive();
      }
      
      this.logger.info(`Connected to Modbus device: ${this.device.name}`);
      
    } catch (error) {
      this.connected = false;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to connect to Modbus device ${this.device.name}: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Disconnect from the Modbus device
   */
  async disconnect(): Promise<void> {
    try {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
      
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = undefined;
      }
      
      if (this.client.isOpen) {
        // Properly await close callback (modbus-serial uses callbacks, not promises)
        await new Promise<void>((resolve) => {
          this.client.close(() => {
            this.logger.debug(`Disconnected from Modbus device: ${this.device.name}`);
            resolve();
          });
        });
      }
      
      this.connected = false;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error disconnecting from Modbus device ${this.device.name}: ${errorMessage}`);
    }
  }

  /**
   * Read all configured registers and return sensor data points
   * Optimizes by batching contiguous register reads when possible
   */
  async readAllRegisters(): Promise<SensorDataPoint[]> {
    if (!this.connected) {
      // Device not connected - return BAD quality for all registers
      return this.createBadQualityDataPoints('DEVICE_OFFLINE');
    }

    const dataPoints: SensorDataPoint[] = [];
    const timestamp = new Date().toISOString();

    // Group registers by function code for batch optimization
    const registersByFunction = this.groupRegistersByFunction();

    for (const [functionCode, registers] of Object.entries(registersByFunction)) {
      // Try to batch contiguous reads
      const batches = this.optimizeBatches(registers);
      
      for (const batch of batches) {
        if (batch.length === 1) {
          // Single register - read individually
          const register = batch[0];
          try {
            const value = await this.readRegisterWithRetry(register);
            
            // Track successful read
            this.lastSuccessfulRead = Date.now();
            
            dataPoints.push({
              deviceName: this.device.name,
              registerName: register.name,
              value: value,
              unit: register.unit || '',
              timestamp: timestamp,
              quality: 'GOOD'
            });
          } catch (error) {
            dataPoints.push(this.createBadDataPoint(register, timestamp, error));
          }
        } else {
          // Batch read - multiple contiguous registers
          try {
            const batchResults = await this.readRegisterBatch(batch);
            
            // Track successful batch read
            this.lastSuccessfulRead = Date.now();
            
            for (const result of batchResults) {
              dataPoints.push({
                deviceName: this.device.name,
                registerName: result.register.name,
                value: result.value,
                unit: result.register.unit || '',
                timestamp: timestamp,
                quality: 'GOOD'
              });
            }
          } catch (error) {
            // Batch read failed - fall back to individual reads
            this.logger.warn(`Batch read failed, falling back to individual reads: ${error}`);
            
            for (const register of batch) {
              try {
                const value = await this.readRegisterWithRetry(register);
                
                // Track successful fallback read
                this.lastSuccessfulRead = Date.now();
                
                dataPoints.push({
                  deviceName: this.device.name,
                  registerName: register.name,
                  value: value,
                  unit: register.unit || '',
                  timestamp: timestamp,
                  quality: 'GOOD'
                });
              } catch (individualError) {
                dataPoints.push(this.createBadDataPoint(register, timestamp, individualError));
              }
            }
          }
        }
      }
    }

    return dataPoints;
  }
  
  /**
   * Group registers by function code
   */
  private groupRegistersByFunction(): Record<number, any[]> {
    const groups: Record<number, any[]> = {};
    
    for (const register of this.device.registers) {
      const fc = register.functionCode;
      if (!groups[fc]) {
        groups[fc] = [];
      }
      groups[fc].push(register);
    }
    
    return groups;
  }
  
  /**
   * Optimize register reads by batching contiguous addresses
   * Groups registers that can be read in a single request
   */
  private optimizeBatches(registers: any[]): any[][] {
    if (registers.length === 0) return [];
    
    // Sort by address
    const sorted = [...registers].sort((a, b) => a.address - b.address);
    
    const batches: any[][] = [];
    let currentBatch: any[] = [sorted[0]];
    let currentEnd = sorted[0].address + (sorted[0].count || 1);
    
    for (let i = 1; i < sorted.length; i++) {
      const reg = sorted[i];
      const gap = reg.address - currentEnd;
      
      // Check if we can batch this register (contiguous or small gap)
      // Allow gaps up to 2 registers for efficiency (reading a few extra registers is often faster than separate requests)
      const canBatch = gap <= 2 && (currentEnd - currentBatch[0].address + reg.count) <= 125; // Modbus max 125 registers
      
      if (canBatch) {
        currentBatch.push(reg);
        currentEnd = reg.address + (reg.count || 1);
      } else {
        // Start new batch
        batches.push(currentBatch);
        currentBatch = [reg];
        currentEnd = reg.address + (reg.count || 1);
      }
    }
    
    // Add final batch
    batches.push(currentBatch);
    
    return batches;
  }
  
  /**
   * Read a batch of contiguous registers in a single request
   */
  private async readRegisterBatch(registers: any[]): Promise<Array<{ register: any; value: number | boolean | string }>> {
    if (registers.length === 0) return [];
    
    // Calculate batch read parameters
    const firstReg = registers[0];
    const lastReg = registers[registers.length - 1];
    const startAddress = firstReg.address;
    const endAddress = lastReg.address + (lastReg.count || 1);
    const totalCount = endAddress - startAddress;
    
    // Perform batch read with timeout and mutex
    const timeout = this.device.connection.timeout || 5000;
    const rawData = await this.withTimeout(
      this.lock(() => this.readBatchRaw(firstReg.functionCode, startAddress, totalCount)),
      timeout,
      `batch read ${registers.length} registers`
    );
    
    // Parse individual register values from batch result
    const results: Array<{ register: any; value: number | boolean | string }> = [];
    
    for (const register of registers) {
      const offset = register.address - startAddress;
      const registerData = {
        data: rawData.data.slice(offset, offset + (register.count || 1))
      };
      
      let value: number | boolean | string;
      
      if (register.functionCode === ModbusFunctionCode.READ_COILS || 
          register.functionCode === ModbusFunctionCode.READ_DISCRETE_INPUTS) {
        value = this.parseCoilData(registerData, register);
      } else {
        value = this.parseRegisterData(registerData, register);
      }
      
      results.push({ register, value });
    }
    
    return results;
  }
  
  /**
   * Perform raw batch read (not wrapped in retry logic)
   */
  private async readBatchRaw(functionCode: number, address: number, count: number): Promise<any> {
    switch (functionCode) {
      case ModbusFunctionCode.READ_COILS:
        return await this.client.readCoils(address, count);
      case ModbusFunctionCode.READ_DISCRETE_INPUTS:
        return await this.client.readDiscreteInputs(address, count);
      case ModbusFunctionCode.READ_HOLDING_REGISTERS:
        return await this.client.readHoldingRegisters(address, count);
      case ModbusFunctionCode.READ_INPUT_REGISTERS:
        return await this.client.readInputRegisters(address, count);
      default:
        throw new Error(`Unsupported function code for batch read: ${functionCode}`);
    }
  }
  
  /**
   * Create BAD quality data point from error
   */
  private createBadDataPoint(register: any, timestamp: string, error: unknown): SensorDataPoint {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Failed to read register ${register.name} from device ${this.device.name}: ${errorMessage}`);
    
    const qualityCode = this.extractQualityCode(errorMessage);
    
    return {
      deviceName: this.device.name,
      registerName: register.name,
      value: null,
      unit: register.unit || '',
      timestamp: timestamp,
      quality: 'BAD',
      qualityCode: qualityCode
    };
  }
  
  /**
   * Read register with automatic retry on DEVICE_BUSY (Exception 6)
   */
  private async readRegisterWithRetry(register: any, retryCount = 0): Promise<number | boolean | string> {
    const maxRetries = 3;
    const retryDelay = 100; // 100ms delay for device busy
    
    try {
      // Wrap read with external timeout to prevent indefinite hangs
      const timeout = this.device.connection.timeout || 5000;
      return await this.withTimeout(
        this.readRegister(register),
        timeout,
        `read register ${register.name}`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const qualityCode = this.extractQualityCode(errorMessage);
      
      // Check for fatal serial port errors - trigger immediate reconnect
      if (this.isFatalSerialError(errorMessage)) {
        this.logger.error(
          `Fatal serial error detected for device ${this.device.name}: ${errorMessage}`
        );
        this.connected = false;
        this.scheduleReconnect();
        throw error;
      }
      
      // Auto-retry on DEVICE_BUSY or ACKNOWLEDGE (device processing previous request)
      if ((qualityCode === 'DEVICE_BUSY' || qualityCode === 'ACKNOWLEDGE') && retryCount < maxRetries) {
        this.logger.debug(
          `Device ${this.device.name} busy, retrying register ${register.name} (attempt ${retryCount + 1}/${maxRetries})`
        );
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        
        // Recursive retry
        return this.readRegisterWithRetry(register, retryCount + 1);
      }
      
      // Not retryable or max retries exceeded
      throw error;
    }
  }
  
  /**
   * Check if error is a fatal serial port error requiring immediate reconnection
   */
  private isFatalSerialError(errorMessage: string): boolean {
    return (
      errorMessage.includes('EPIPE') ||      // Broken pipe - device disconnected
      errorMessage.includes('EIO') ||        // I/O error - serial port disappeared
      errorMessage.includes('ENXIO') ||      // Device not configured
      errorMessage.includes('ENODEV') ||     // No such device
      errorMessage.includes('Port is not open') ||
      errorMessage.includes('Port is opening')
    );
  }

  /**
   * Create BAD quality data points for all registers when device is offline
   */
  private createBadQualityDataPoints(qualityCode: string): SensorDataPoint[] {
    const timestamp = new Date().toISOString();
    return this.device.registers.map(register => ({
      deviceName: this.device.name,
      registerName: register.name,
      value: null,
      unit: register.unit || '',
      timestamp: timestamp,
      quality: 'BAD' as const,
      qualityCode: qualityCode
    }));
  }

  /**
   * Extract quality code from error message
   */
  private extractQualityCode(errorMessage: string): string {
    // Fatal serial port errors (immediate reconnect needed)
    if (errorMessage.includes('EPIPE')) return 'BROKEN_PIPE';
    if (errorMessage.includes('EIO')) return 'IO_ERROR';
    if (errorMessage.includes('ENXIO')) return 'DEVICE_NOT_CONFIGURED';
    if (errorMessage.includes('ENODEV')) return 'NO_SUCH_DEVICE';
    if (errorMessage.includes('Port is not open') || errorMessage.includes('Port is opening')) {
      return 'PORT_NOT_OPEN';
    }
    
    // Modbus-specific exception codes (more specific than generic errors)
    if (errorMessage.includes('Exception Code: 1') || errorMessage.includes('Exception 1')) {
      return 'ILLEGAL_FUNCTION';
    }
    if (errorMessage.includes('Exception Code: 2') || errorMessage.includes('Exception 2')) {
      return 'ILLEGAL_ADDRESS';
    }
    if (errorMessage.includes('Exception Code: 3') || errorMessage.includes('Exception 3')) {
      return 'ILLEGAL_VALUE';
    }
    if (errorMessage.includes('Exception Code: 4') || errorMessage.includes('Exception 4')) {
      return 'DEVICE_FAILURE';
    }
    if (errorMessage.includes('Exception Code: 5') || errorMessage.includes('Exception 5')) {
      return 'ACKNOWLEDGE';
    }
    if (errorMessage.includes('Exception Code: 6') || errorMessage.includes('Exception 6')) {
      return 'DEVICE_BUSY';
    }
    if (errorMessage.includes('Exception Code: 7') || errorMessage.includes('Exception 7')) {
      return 'NEGATIVE_ACK';
    }
    if (errorMessage.includes('Exception Code: 8') || errorMessage.includes('Exception 8')) {
      return 'MEMORY_ERROR';
    }
    
    // Common network errors
    if (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
      return 'TIMEOUT';
    }
    if (errorMessage.includes('ECONNREFUSED')) {
      return 'CONNECTION_REFUSED';
    }
    if (errorMessage.includes('EHOSTUNREACH')) {
      return 'HOST_UNREACHABLE';
    }
    if (errorMessage.includes('ECONNRESET')) {
      return 'CONNECTION_RESET';
    }
    if (errorMessage.includes('File not found') || errorMessage.includes('ENOENT')) {
      return 'PORT_NOT_FOUND';
    }
    if (errorMessage.includes('Exception')) {
      return 'MODBUS_EXCEPTION';
    }
    
    // Default
    return 'READ_ERROR';
  }

  /**
   * Read a single register
   * CRITICAL: Wrapped with mutex lock to prevent concurrent requests
   */
  private async readRegister(register: any): Promise<number | boolean | string> {
    return this.lock(async () => {
      let rawData: any;

      switch (register.functionCode) {
        case ModbusFunctionCode.READ_COILS:
          rawData = await this.client.readCoils(register.address, register.count);
          return this.parseCoilData(rawData, register);

        case ModbusFunctionCode.READ_DISCRETE_INPUTS:
          rawData = await this.client.readDiscreteInputs(register.address, register.count);
          return this.parseCoilData(rawData, register);

        case ModbusFunctionCode.READ_HOLDING_REGISTERS:
          rawData = await this.client.readHoldingRegisters(register.address, register.count);
          return this.parseRegisterData(rawData, register);

        case ModbusFunctionCode.READ_INPUT_REGISTERS:
          rawData = await this.client.readInputRegisters(register.address, register.count);
          return this.parseRegisterData(rawData, register);

        default:
          throw new Error(`Unsupported function code: ${register.functionCode}`);
      }
    });
  }

  /**
   * Parse coil/discrete input data
   */
  private parseCoilData(data: any, register: any): boolean {
    if (register.dataType === ModbusDataType.BOOLEAN) {
      return data.data[0] || false;
    }
    throw new Error(`Invalid data type ${register.dataType} for coil/discrete input`);
  }

  /**
   * Parse register data based on data type
   */
  private parseRegisterData(data: any, register: any): number | string {
    // Determine byte order (support both new byteOrder and legacy endianness)
    let byteOrder = register.byteOrder || ByteOrder.ABCD;
    
    // Legacy compatibility: map endianness to byteOrder
    if (!register.byteOrder && register.endianness) {
      byteOrder = register.endianness === Endianness.BIG ? ByteOrder.ABCD : ByteOrder.CDAB;
    }
    
    const buffer = Buffer.alloc(register.count * 2);
    
    // For 16-bit values (1 register), byte order doesn't matter - Modbus is always big-endian per register
    if (register.count === 1) {
      buffer.writeUInt16BE(data.data[0], 0);
    } else {
      // For 32-bit values (2 registers), apply byte order
      this.applyByteOrder(buffer, data.data, byteOrder, register.count);
    }

    let value: number;

    switch (register.dataType) {
      case ModbusDataType.INT16:
        value = buffer.readInt16BE(0);
        break;
      case ModbusDataType.UINT16:
        value = buffer.readUInt16BE(0);
        break;
      case ModbusDataType.INT32:
        value = buffer.readInt32BE(0);
        break;
      case ModbusDataType.UINT32:
        value = buffer.readUInt32BE(0);
        break;
      case ModbusDataType.FLOAT32:
        value = buffer.readFloatBE(0);
        break;
      case ModbusDataType.STRING:
        // Use configurable encoding (default: ascii)
        const encoding = (register.encoding || 'ascii') as BufferEncoding;
        let str = buffer.toString(encoding);
        
        // Remove null terminators and trim whitespace
        // Some devices pad with nulls, others with spaces
        str = str.replace(/\0/g, '').trim();
        
        return str;
      default:
        throw new Error(`Unsupported data type: ${register.dataType}`);
    }

    // Apply scaling and offset
    return (value * register.scale) + register.offset;
  }

  /**
   * Apply byte order to buffer based on ABCD notation
   * Modbus registers are always read as big-endian 16-bit values,
   * but the order of those registers for 32-bit values varies
   */
  private applyByteOrder(buffer: Buffer, registers: number[], byteOrder: ByteOrder, count: number): void {
    switch (byteOrder) {
      case ByteOrder.ABCD: // Big-endian (standard Modbus)
        // reg0 = AB (high word), reg1 = CD (low word)
        for (let i = 0; i < count; i++) {
          buffer.writeUInt16BE(registers[i], i * 2);
        }
        break;
        
      case ByteOrder.CDAB: // Word-swapped (common in devices)
        // reg0 = CD (low word), reg1 = AB (high word)
        for (let i = 0; i < count; i++) {
          buffer.writeUInt16BE(registers[count - 1 - i], i * 2);
        }
        break;
        
      case ByteOrder.BADC: // Byte-swapped within words
        // reg0 = BA, reg1 = DC
        for (let i = 0; i < count; i++) {
          buffer.writeUInt16LE(registers[i], i * 2);
        }
        break;
        
      case ByteOrder.DCBA: // Full little-endian
        // reg0 = DC, reg1 = BA
        for (let i = 0; i < count; i++) {
          buffer.writeUInt16LE(registers[count - 1 - i], i * 2);
        }
        break;
        
      default:
        throw new Error(`Unsupported byte order: ${byteOrder}`);
    }
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected && this.client.isOpen;
  }
  
  /**
   * Get health statistics
   */
  getHealthStats(): {
    connected: boolean;
    lastSuccessfulRead: Date;
    lastConnectionSuccess: Date;
    secondsSinceLastRead: number;
    secondsSinceLastConnection: number;
    consecutiveFailures: number;
    currentRetryDelay: number;
  } {
    const now = Date.now();
    return {
      connected: this.connected,
      lastSuccessfulRead: new Date(this.lastSuccessfulRead),
      lastConnectionSuccess: new Date(this.lastConnectionSuccess),
      secondsSinceLastRead: Math.floor((now - this.lastSuccessfulRead) / 1000),
      secondsSinceLastConnection: Math.floor((now - this.lastConnectionSuccess) / 1000),
      consecutiveFailures: this.consecutiveFailures,
      currentRetryDelay: this.currentRetryDelay
    };
  }

  /**
   * Start keep-alive timer for TCP connections
   * Prevents gateway/firewall from dropping idle connections
   * Only enabled for TCP (RTU/serial doesn't need this)
   */
  private startKeepAlive(): void {
    // Clear existing timer if any
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }
    
    this.keepAliveTimer = setInterval(async () => {
      if (!this.connected || !this.client.isOpen) {
        return;
      }
      
      try {
        // Send dummy read to keep connection alive
        // Read 1 register from address 0 (most devices support this)
        await this.lock(() => this.client.readHoldingRegisters(0, 1));
        
        this.logger.debug(`Keep-alive ping successful for device ${this.device.name}`);
      } catch (error) {
        // Silent failure - keep-alive is best-effort
        // Real errors will be caught during actual polling
        this.logger.debug(`Keep-alive ping failed for device ${this.device.name} (non-critical)`);
      }
    }, this.KEEP_ALIVE_INTERVAL);
    
    // Don't prevent process exit
    this.keepAliveTimer.unref();
    
    this.logger.debug(`Keep-alive enabled for TCP device ${this.device.name} (interval: ${this.KEEP_ALIVE_INTERVAL}ms)`);
  }

  /**
   * Setup error handlers
   */
  private setupErrorHandlers(): void {
    this.client.on('error', (error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Modbus client error for device ${this.device.name}: ${errorMessage}`);
      this.connected = false;
      this.scheduleReconnect();
    });

    this.client.on('close', () => {
      this.logger.warn(`Modbus connection closed for device ${this.device.name}`);
      this.connected = false;
      this.scheduleReconnect();
    });
  }

  /**
   * Schedule automatic reconnection with exponential backoff
   * Prevents log spam and CPU spikes when device is offline for extended periods
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.consecutiveFailures++;
    
    // Exponential backoff: 5s → 10s → 20s → 40s → 60s (max)
    this.currentRetryDelay = Math.min(
      this.currentRetryDelay * 2,
      this.MAX_RETRY_DELAY
    );
    
    this.logger.info(
      `Scheduling reconnect for device ${this.device.name} in ${this.currentRetryDelay / 1000}s ` +
      `(attempt ${this.consecutiveFailures})`
    );
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connect();
      } catch (error) {
        this.logger.error(`Reconnection failed for device ${this.device.name}`);
        this.scheduleReconnect();
      }
    }, this.currentRetryDelay);
  }
}
