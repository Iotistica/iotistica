import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { SensorDataPoint, SocketOutput, Logger } from '../types.js';

/**
 * IPC Socket Server that receives sensor data and serves it to connected clients
 * Supports both Unix Domain Sockets (Linux/macOS) and Named Pipes (Windows)
 */
export class SocketServer {
  private server?: net.Server;
  private clients: net.Socket[] = [];
  private config: SocketOutput;
  private logger: Logger;
  private started = false;
  private isWindowsNamedPipe: boolean;
  private readonly MAX_CLIENTS = 10; // Prevent IPC DoS attacks

  constructor(config: SocketOutput, logger: Logger) {
    this.config = config;
    this.logger = logger;
    
    // Detect if this is a Windows Named Pipe
    this.isWindowsNamedPipe = this.config.socketPath.startsWith('\\\\.\\pipe\\');
  }

  /**
   * Start the IPC socket server (Unix socket or Windows Named Pipe)
   */
  async start(): Promise<void> {
    if (this.started) {
      this.logger.debug(`IPC server already running at: ${this.config.socketPath}`);
      return;
    }

    try {
      // For Unix sockets, ensure directory exists and clean up old socket
      if (!this.isWindowsNamedPipe) {
        const socketDir = path.dirname(this.config.socketPath);
        if (!fs.existsSync(socketDir)) {
          fs.mkdirSync(socketDir, { recursive: true });
        }

        // Remove existing socket file if it exists
        if (fs.existsSync(this.config.socketPath)) {
          fs.unlinkSync(this.config.socketPath);
        }
      }

      this.server = net.createServer((socket) => {
        this.handleClientConnection(socket);
      });

      await new Promise<void>((resolve, reject) => {
        let settled = false;

        this.server!.listen(this.config.socketPath, () => {
          const transportType = this.isWindowsNamedPipe ? 'Windows Named Pipe' : 'Unix socket';
          this.logger.info(`IPC server started (${transportType}) at: ${this.config.socketPath}`);
          
          // Set restrictive permissions on Unix socket file (owner + group only)
          // Prevents unauthorized local processes from connecting
          if (!this.isWindowsNamedPipe) {
            try {
              fs.chmodSync(this.config.socketPath, 0o660);
            } catch (error) {
              this.logger.warn(`Failed to set socket permissions: ${error}`);
            }
          }
          
          this.started = true;
          settled = true;
          resolve();
        });

        // Handle errors during startup and post-startup
        this.server!.on('error', (error) => {
          if (!settled) {
            // Startup error - reject promise
            reject(error);
          } else {
            // Runtime error after successful start
            this.logger.error(`Socket server runtime error: ${error.message}`);
          }
        });
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start socket server: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Stop the IPC socket server (Unix socket or Windows Named Pipe)
   */
  async stop(): Promise<void> {
    if (!this.started || !this.server) {
      return;
    }

    try {
      // Close all client connections
      for (const client of this.clients) {
        client.destroy();
      }
      this.clients = [];

      // Close server
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          const transportType = this.isWindowsNamedPipe ? 'Windows Named Pipe' : 'Unix socket';
          this.logger.debug(`IPC server stopped (${transportType})`);
          resolve();
        });
      });

      // Remove Unix socket file (Named Pipes are cleaned up automatically by Windows)
      if (!this.isWindowsNamedPipe) {
        try {
          if (fs.existsSync(this.config.socketPath)) {
            fs.unlinkSync(this.config.socketPath);
          }
        } catch (unlinkError: any) {
          // Ignore ENOENT (file already deleted) - not an error condition
          if (unlinkError?.code !== 'ENOENT') {
            this.logger.warn(`Failed to remove socket file: ${unlinkError?.message || unlinkError}`);
          }
        }
      }

      this.started = false;
      this.server = undefined;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error stopping socket server: ${errorMessage}`);
    }
  }

  /**
   * Send sensor data to all connected clients
   * 
   * Backpressure handling: Drops slow consumers instead of buffering
   * Rationale: Real-time telemetry data loses value quickly, and slow consumers
   * shouldn't block fast ones or cause memory growth on edge devices.
   * 
   * TODO (OPTIMIZATION): Broadcast amplification at high scale
   * 
   * Current approach: Write same payload N times (one per client)
   * - Fine for typical edge deployments (1-2 clients, <1k msgs/sec)
   * - Becomes CPU-bound at high scale (10+ clients × 1k msgs/sec = 10k syscalls/sec)
   * 
   * Optimization strategies (if profiling shows bottleneck):
   * 1. Per-client sampling: Fast clients get all data, debug clients get every Nth message
   * 2. Shared memory: Write once, clients read at their own pace (zero-copy broadcast)
   * 3. Client rate limiting: Cap per-client throughput (e.g., max 100 msgs/sec)
   * 
   * Decision: Keep simple broadcast until proven hot. The backpressure handling
   * already prevents the critical failure mode (OOM from slow consumers).
   */
  sendData(dataPoints: SensorDataPoint[]): void {
    if (!this.started || this.clients.length === 0) {
      return;
    }

    try {
      const message = this.formatData(dataPoints);
      const data = message + this.config.delimiter;

      // Send to all connected clients with backpressure handling
      this.clients.forEach((client, index) => {
        try {
          const flushed = client.write(data);
          
          // Backpressure detected: kernel buffer full
          if (!flushed) {
            this.logger.warn(`Dropping slow IPC client (backpressure detected) at ${this.config.socketPath}`, {
              clientIndex: index,
              bufferSize: data.length,
              reason: 'kernel_buffer_full'
            });
            this.removeClient(client);
          }
        } catch (error) {
          this.logger.warn(`Failed to send data to client ${index}: ${error}`);
          this.removeClient(client);
        }
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error sending data: ${errorMessage}`);
    }
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.length;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.started;
  }

  /**
   * Handle new client connection
   */
  private handleClientConnection(socket: net.Socket): void {
    // Prevent IPC DoS: reject connections beyond max client limit
    if (this.clients.length >= this.MAX_CLIENTS) {
      this.logger.warn(`Rejected IPC client (max ${this.MAX_CLIENTS} clients reached) at ${this.config.socketPath}`);
      socket.destroy();
      return;
    }

    this.clients.push(socket);

    // Use 'once' to prevent duplicate cleanup when multiple events fire
    // (error → close → end can all trigger for same disconnect)
    socket.once('error', (error) => {
      this.logger.warn(`Client socket error: ${error.message}`);
      this.removeClient(socket);
    });

    socket.once('close', () => {
      this.removeClient(socket);
    });

    socket.once('end', () => {
      this.removeClient(socket);
    });
  }

  /**
   * Remove client from the list
   */
  private removeClient(socket: net.Socket): void {
    const index = this.clients.indexOf(socket);
    if (index > -1) {
      this.clients.splice(index, 1);
      try {
        socket.destroy();
      } catch (error) {
        // Ignore errors when destroying socket
      }
    }
  }

  /**
   * Format sensor data based on configuration
   * 
   * TODO (PRODUCTION): Replace delimiter-based framing with robust protocol
   * 
   * Current approach: message + delimiter (e.g., '\n')
   * Limitations:
   * - JSON data could contain delimiter (e.g., user input with embedded '\n')
   * - Partial write() calls could split frames (rare on IPC, common on network sockets)
   * - Client reading mid-frame gets corrupted data
   * 
   * Why it works now (POC-acceptable):
   * - JSON.stringify() produces single-line output (no embedded '\n')
   * - IPC sockets (Unix/Named Pipe) have low partial-write probability
   * - Trusted clients (sensor-publish) with controlled input
   * 
   * Production alternatives:
   * 1. Length-prefixed framing: 4-byte uint32 length + payload (most robust)
   * 2. NDJSON: Newline-delimited JSON with validation (simpler, less safe)
   * 3. MessagePack framing: Aligns with existing compression stack (recommended)
   * 
   * Recommendation: Migrate to MessagePack framing when consolidating serialization.
   * This matches the sensor-publish msgpack usage and provides type-safe framing.
   */
  private formatData(dataPoints: SensorDataPoint[]): string {
    if (this.config.dataFormat === 'csv') {
      return this.formatAsCsv(dataPoints);
    } else {
      return this.formatAsJson(dataPoints);
    }
  }

  /**
   * Format data as JSON
   * Returns flat array of readings for cleaner database storage
   */
  private formatAsJson(dataPoints: SensorDataPoint[]): string {
    const timestamp = new Date().toISOString();
    
    // Create flat array of readings (one per register)
    const readings = dataPoints.map(point => ({
      timestamp: point.timestamp,
      deviceName: point.deviceName,
      ...(point.deviceId && { deviceId: point.deviceId, device_id: point.deviceId }),
      ...(point.endpoint_uuid && { endpoint_uuid: point.endpoint_uuid }),
      ...(point.device_uuid && { device_uuid: point.device_uuid }),
      metric: point.metric,
      value: point.value,
      unit: point.unit,
      quality: point.quality,
      ...(point.qualityCode && { qualityCode: point.qualityCode })
    }));
    
    // Return array directly for single reading, or wrapped for batch
    if (readings.length === 1) {
      return JSON.stringify(readings[0]);
    } else {
      return JSON.stringify({ timestamp, readings });
    }
  }

  /**
   * Format data as CSV
   */
  private formatAsCsv(dataPoints: SensorDataPoint[]): string {
    const rows: string[] = [];
    
    for (const point of dataPoints) {
      const row = [
        point.deviceName,
        point.metric,
        String(point.value),
        point.unit,
        point.quality,
        point.timestamp
      ].join(',');
      
      rows.push(row);
    }
    
    return rows.join('\n');
  }
}