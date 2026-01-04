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
   * Force reset the Modbus client instance
   * CRITICAL: modbus-serial does not recover cleanly on the same client instance
   * after connection failures. We must destroy and recreate the client completely.
   */
  private async forceResetClient(): Promise<void> {
    this.logger.debug(`Force resetting Modbus client for device ${this.device.name}`);
    
    try {
      if (this.client.isOpen) {
        this.logger.debug(`Closing existing client connection for ${this.device.name}`);
        await new Promise<void>(resolve => {
          this.client.close(() => resolve());
        });
      }
    } catch (error) {
      // Ignore close errors - client may already be in bad state
      this.logger.debug(`Error closing client during reset: ${error}`);
    }

    // CRITICAL: discard client instance completely
    // This removes poisoned socket state, broken serial port handles, and accumulated event listeners
    // Note: modbus-serial may not expose removeAllListeners, so we just create a new instance
    this.logger.debug(`Creating new ModbusRTU instance for ${this.device.name}`);
    this.client = new ModbusRTU();
    this.setupErrorHandlers();
    this.logger.debug(`Client reset complete for ${this.device.name}`);
  }

  /**
   * Connect to the Modbus device
   */
  async connect(): Promise<void> {
    try {
      this.logger.debug(
        `Connecting to Modbus device: ${this.device.name} (${this.device.connection.type}://${this.device.connection.host || this.device.connection.serialPort})`
      );
      
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
      
      // Set timeout (default 5000ms if not specified)
      const timeout = connection.timeout ?? 5000;
      this.client.setTimeout(timeout);
      
      this.connected = true;
      
      // Reset backoff on successful connection
      this.currentRetryDelay = this.MIN_RETRY_DELAY;
      this.consecutiveFailures = 0;
      this.lastConnectionSuccess = Date.now();
      
      this.logger.debug(
        `[RECOVERY] Connected to ${this.device.name} (slave ${this.device.slaveId}, timeout ${timeout}ms, client.isOpen=${this.client.isOpen})`
      );
      
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
    if (!this.isConnected()) {
      // Device not connected - trigger reconnect and return BAD quality for this iteration
      // Next poll cycle will likely succeed since reconnect will be in progress
      this.logger.debug(
        `[RECOVERY] readAllRegisters: Device ${this.device.name} not connected (client.isOpen=${this.client.isOpen}), triggering reconnect`
      );
      await this.tryEnsureConnected();
      return this.createBadQualityDataPoints('DEVICE_OFFLINE');
    }

    this.logger.debug(
      `[RECOVERY] readAllRegisters: Device ${this.device.name} connected (client.isOpen=${this.client.isOpen}), proceeding with reads`
    );

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
            if (this.consecutiveFailures > 0) {
              this.logger.debug(
                `[RECOVERY] Device ${this.device.name} recovered! Read succeeded after ${this.consecutiveFailures} failures`
              );
            }
            this.consecutiveFailures = 0; // Reset failure counter on success
            
            dataPoints.push({
              deviceName: this.device.name,
              metric: register.name,
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
            this.consecutiveFailures = 0; // Reset failure counter on success
            
            for (const result of batchResults) {
              dataPoints.push({
                deviceName: this.device.name,
                metric: result.register.name,
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
                this.consecutiveFailures = 0; // Reset failure counter on success
                
                dataPoints.push({
                  deviceName: this.device.name,
                  metric: register.name,
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
    try {
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[MODBUS READ EXCEPTION] Device ${this.device.name} slave=${this.device.slaveId} FC${functionCode} addr=${address}: ${errorMessage}`);
      throw error;
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
      metric: register.name,
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
      
      // Track read failure - may trigger reconnect if too many consecutive failures
      // This catches timeouts (ETIMEDOUT) that don't close sockets
      await this.onReadFailure(errorMessage);
      
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
   * Handle read failure and escalate to reconnect if too many consecutive failures
   * CRITICAL: Modbus timeouts (ETIMEDOUT) don't close sockets or emit error events,
   * so we must track consecutive failures and force reconnect after threshold
   */
  private async onReadFailure(errorMessage: string): Promise<void> {
    this.consecutiveFailures++;
    
    this.logger.debug(
      `[RECOVERY] Read failure #${this.consecutiveFailures} for ${this.device.name}: ${errorMessage.substring(0, 100)}`
    );

    // After 3 consecutive failures, assume device is offline and force reconnect
    // This catches timeouts that don't trigger socket close events
    if (this.consecutiveFailures >= 3) {
      this.logger.debug(
        `[RECOVERY] ⚠️ Too many consecutive failures (${this.consecutiveFailures}) for ${this.device.name}, forcing reconnect`
      );
      this.logger.debug(
        `[RECOVERY] Setting connected=false, client.isOpen=${this.client.isOpen}, calling forceResetClient`
      );
      this.connected = false;
      await this.forceResetClient();
      // Don't increment consecutiveFailures in scheduleReconnect since we already did it here
      this.scheduleReconnectInternal(false);
    }
  }

  /**
   * Create BAD quality data points for all registers when device is offline
   */
  private createBadQualityDataPoints(qualityCode: string): SensorDataPoint[] {
    const timestamp = new Date().toISOString();
    return this.device.registers.map(register => ({
      deviceName: this.device.name,
      metric: register.name,
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

      try {
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
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`Device ${this.device.name} slave=${this.device.slaveId} ${register.name}: ${errorMessage}`);
        throw error;
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
    // Trust the underlying socket state - this.connected may be stale
    return this.client.isOpen;
  }
  
  /**
   * Ensure connection or schedule reconnect if needed
   * Called by readAllRegisters() to actively recover from disconnections
   */
  private async tryEnsureConnected(): Promise<void> {
    if (this.client.isOpen) {
      this.logger.debug(
        `[RECOVERY] tryEnsureConnected: Device ${this.device.name} already connected (client.isOpen=true), skipping`
      );
      return;
    }
    if (this.reconnectTimer) {
      this.logger.debug(
        `[RECOVERY] tryEnsureConnected: Device ${this.device.name} reconnect already scheduled, skipping duplicate`
      );
      return;
    }

    this.logger.debug(
      `[RECOVERY] tryEnsureConnected: Device ${this.device.name} disconnected (client.isOpen=false), forcing reconnect (failures=${this.consecutiveFailures})`
    );
    this.scheduleReconnect();
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
   * Setup error handlers
   */
  private setupErrorHandlers(): void {
    this.client.on('error', (error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[RECOVERY] Socket error for device ${this.device.name}: ${errorMessage}`
      );
      this.connected = false;
      this.consecutiveFailures++; // Explicit failure count for error event
      this.logger.debug(
        `[RECOVERY] Setting connected=false, client.isOpen=${this.client.isOpen}, scheduling reconnect (failures: ${this.consecutiveFailures})`
      );
      this.scheduleReconnect();
    });

    this.client.on('close', () => {
      this.logger.debug(
        `[RECOVERY] Socket closed for device ${this.device.name}`
      );
      this.connected = false;
      this.consecutiveFailures++; // Explicit failure count for close event
      this.logger.debug(
        `[RECOVERY] Setting connected=false, client.isOpen=${this.client.isOpen}, scheduling reconnect (failures: ${this.consecutiveFailures})`
      );
      this.scheduleReconnect();
    });
  }

  /**
   * Schedule automatic reconnection with exponential backoff
   * Prevents log spam and CPU spikes when device is offline for extended periods
   * NOTE: Caller is responsible for incrementing consecutiveFailures before calling this
   */
  private scheduleReconnect(): void {
    this.scheduleReconnectInternal(false);
  }

  /**
   * Internal reconnect scheduling with control over failure counting
   */
  private scheduleReconnectInternal(incrementFailures: boolean): void {
    if (this.reconnectTimer) {
      this.logger.debug(
        `Reconnect timer already exists for ${this.device.name}, skipping duplicate scheduling`
      );
      return;
    }

    if (incrementFailures) {
      this.consecutiveFailures++;
    }
    
    // Exponential backoff: 5s → 10s → 20s → 40s → 60s (max)
    this.currentRetryDelay = Math.min(
      this.currentRetryDelay * 2,
      this.MAX_RETRY_DELAY
    );
    
    this.logger.debug(
      `[RECOVERY] Scheduling reconnect for ${this.device.name} in ${this.currentRetryDelay / 1000}s ` +
      `(failures=${this.consecutiveFailures}, connected=${this.connected}, client.isOpen=${this.client.isOpen})`
    );
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.logger.debug(`[RECOVERY] 🔄 Reconnect timer fired for ${this.device.name}`);
      
      // Execute reconnection attempt
      (async () => {
        try {
          this.logger.debug(
            `[RECOVERY] Attempting reconnection for ${this.device.name} (failures=${this.consecutiveFailures})...`
          );
          
          // CRITICAL: Must fully reset client before reconnecting
          // Reusing the same ModbusRTU instance after failures leads to corrupted state
          await this.forceResetClient();
          await this.connect();
          
          this.logger.debug(
            `[RECOVERY] Reconnection completed for ${this.device.name}. Next poll will verify slave response.`
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.debug(
            `[RECOVERY] ❌ Reconnection failed for ${this.device.name}: ${errorMessage}`
          );
          this.logger.debug(`[RECOVERY] Will reschedule another reconnection attempt`);
          
          // CRITICAL: Always reschedule on failure for indefinite reconnection
          this.scheduleReconnect();
        }
      })().catch(err => {
        // Safety net: catch any unhandled promise rejections
        this.logger.error(
          `Unhandled error in reconnection callback for device ${this.device.name}: ${err}`
        );
        this.logger.debug(`Rescheduling reconnect after unhandled error`);
        this.scheduleReconnect();
      });
    }, this.currentRetryDelay);
    
    this.logger.debug(`Reconnect timer created (delay: ${this.currentRetryDelay}ms)`);
  }
}
