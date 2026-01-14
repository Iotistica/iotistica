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

  // Global ingress rate limiter (token bucket)
  // Byte-based tokens correlate better with Redis memory pressure
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // bytes/sec (configurable via env)
  private lastRefill = Date.now();
  private lastRateLimitLog = 0; // Throttle hot-path logging

  // Warmup configuration
  private readonly WARMUP_DURATION_MS = 10_000; // Fixed 10s warmup period
  private readonly WARMUP_DROP_RATE = 10; // Drop 9/10 messages during warmup

  // Stats tracking
  private stats = {
    messagesAccepted: 0,
    messagesDroppedRateLimit: 0,
    messagesDroppedWarmup: 0,
    clientsDroppedRateLimit: 0
  };

  constructor(config: SocketOutput, logger: Logger) {
    this.config = config;
    this.logger = logger;
    
    // Detect if this is a Windows Named Pipe
    this.isWindowsNamedPipe = this.config.socketPath.startsWith('\\\\.\\pipe\\');

    // Configure byte-based rate limits from environment
    // Default: 500 KB/sec refill rate (handles ~500 1KB messages/sec)
    // Correlates with Redis memory pressure better than message count
    const envRefillRate = parseInt(process.env.SOCKET_INGRESS_RATE_LIMIT || '512000', 10);
    this.refillRate = envRefillRate > 0 ? envRefillRate : 512000; // bytes/sec
    this.maxTokens = this.refillRate * 2; // 2-second burst capacity
    this.tokens = this.maxTokens;
  }

  /**
   * Refill token bucket based on elapsed time
   * Called before every sendData() to maintain steady-state rate
   * 
   * Byte-based tokens: Correlates with Redis memory pressure better than message count
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;

    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRate
    );
  }

  /**
   * Start the IPC socket server (Unix socket or Windows Named Pipe)
   */
  async start(): Promise<void> {
    if (this.started) {
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
          this.logger.info(`IPC server stopped (${transportType})`);
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
   * 4-LAYER ADMISSION CONTROL (Ingress Gate):
   * 
   * Layer 1: Global token bucket rate limiter (byte-based)
   *   - Guarantees Redis never sees more than REFILL_RATE bytes/sec
   *   - Byte-based accounting correlates with Redis memory pressure
   *   - Prevents synchronized startup storms (50 devices × 10 KB/sec = 500 KB/sec burst)
   *   - Default: 512 KB/sec refill, 1024 KB capacity (2-second burst)
   * 
   * Layer 2: Warm-up throttling (per-client)
   *   - First 10 seconds: drop 9 out of 10 messages
   *   - Reduces initial CPU/memory pressure during reconnect storms
   *   - Prevents 50 simulators → 50 immediate floods
   * 
   * Layer 3: Per-client rate limiting
   *   - Track msgs/sec per socket, drop clients exceeding limits
   *   - Prevents single misbehaving simulator from monopolizing capacity
   *   - Default: 100 msgs/sec per client
   * 
   * Layer 4: Backpressure handling (kernel buffer)
   *   - Drops slow consumers instead of buffering
   *   - Prevents OOM from slow readers blocking fast writers
   * 
   * Why this is the correct layer:
   * - Sits BEFORE JSON parsing, batching, compression, MQTT publish
   * - Blocking here saves CPU, memory, and prevents synchronized load downstream
   * - This is the Ingress Gate protecting the entire pipeline
   */
  sendData(dataPoints: SensorDataPoint[]): void {
    if (!this.started || this.clients.length === 0) {
      return;
    }

    try {
      const message = this.formatData(dataPoints);
      const data = message + this.config.delimiter;
      const payloadBytes = Buffer.byteLength(data, 'utf8');
      const now = Date.now();

      // Layer 1: Global rate limiter (byte-based token bucket)
      // Bytes correlate better with Redis memory pressure than message count
      this.refillTokens();
      if (this.tokens < payloadBytes) {
        this.stats.messagesDroppedRateLimit += dataPoints.length;
        
        // Throttle logging: Log once per second to avoid flooding under load
        if (now - this.lastRateLimitLog > 1000) {
          this.logger.warn('Ingress rate limited: dropping sensor data', {
            dropped: dataPoints.length,
            payloadBytes,
            tokensAvailable: Math.floor(this.tokens),
            refillRate: this.refillRate,
            totalDropped: this.stats.messagesDroppedRateLimit
          });
          this.lastRateLimitLog = now;
        }
        return;
      }
      this.tokens -= payloadBytes;
      this.stats.messagesAccepted += dataPoints.length;

      // Send to all connected clients with multi-layer admission control
      this.clients.forEach((client, index) => {
        try {
          const clientMeta = client as any;

          // Layer 2: Warm-up throttling
          // Phase 1: Jitter delay (client can't send until startAcceptAt)
          // Phase 2: Warmup period (drop 9/10 messages for WARMUP_DURATION_MS)
          if (now < clientMeta._startAcceptAt) {
            this.stats.messagesDroppedWarmup++;
            return; // Still in jitter delay, drop all messages
          }
          
          if (now < clientMeta._warmupUntil) {
            clientMeta._warmupCounter = (clientMeta._warmupCounter || 0) + 1;
            if (clientMeta._warmupCounter % this.WARMUP_DROP_RATE !== 0) {
              this.stats.messagesDroppedWarmup++;
              return; // Drop 9 out of 10 messages during warmup
            }
          }

          // Layer 3: Per-client rate limiting (100 msgs/sec)
          const PER_CLIENT_RATE_LIMIT = 100; // msgs/sec
          const RATE_WINDOW_MS = 1000;
          
          if (!clientMeta._rateWindow || (now - clientMeta._rateWindow) >= RATE_WINDOW_MS) {
            // Reset window
            clientMeta._rateWindow = now;
            clientMeta._rateCount = 0;
          }
          
          clientMeta._rateCount++;
          if (clientMeta._rateCount > PER_CLIENT_RATE_LIMIT) {
            this.logger.warn(`Dropping fast IPC client (rate limit exceeded) at ${this.config.socketPath}`, {
              clientIndex: index,
              rate: clientMeta._rateCount,
              limit: PER_CLIENT_RATE_LIMIT
            });
            this.stats.clientsDroppedRateLimit++;
            this.removeClient(client);
            return;
          }

          // Layer 4: Backpressure handling (kernel buffer)
          const flushed = client.write(data);
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
   * Get ingress control statistics
   * Used for monitoring and alerting on admission control effectiveness
   */
  getStats() {
    return {
      ...this.stats,
      tokensAvailable: Math.floor(this.tokens),
      tokensAvailableKB: (this.tokens / 1024).toFixed(2),
      maxTokens: this.maxTokens,
      maxTokensKB: (this.maxTokens / 1024).toFixed(2),
      refillRate: this.refillRate,
      refillRateKBps: (this.refillRate / 1024).toFixed(2),
      activeClients: this.clients.length,
      dropRate: this.stats.messagesAccepted > 0
        ? (this.stats.messagesDroppedRateLimit / this.stats.messagesAccepted * 100).toFixed(2) + '%'
        : '0%'
    };
  }

  /**
   * Handle new client connection
   * 
   * NOTE: Warmup prevents data spikes from adapter restarts overwhelming the pipeline.
   * Unix domain sockets are local-only, so warmup is brief (no network delay).
   */
  private handleClientConnection(socket: net.Socket): void {
    // Prevent IPC DoS: reject connections beyond max client limit
    if (this.clients.length >= this.MAX_CLIENTS) {
      this.logger.warn(`Rejected IPC client (max ${this.MAX_CLIENTS} clients reached) at ${this.config.socketPath}`);
      socket.destroy();
      return;
    }

    // Apply warmup: delay data acceptance to prevent burst overload
    const jitter = Math.floor(Math.random() * 10000); // 0-10s jitter
    (socket as any)._startAcceptAt = Date.now() + jitter; // Random start delay
    (socket as any)._warmupUntil = (socket as any)._startAcceptAt + 10000; // 10s warmup after start
    (socket as any)._warmupCounter = 0;

    // Per-client rate tracking
    (socket as any)._rateWindow = Date.now();
    (socket as any)._rateCount = 0;

    this.logger.debug(`New IPC client connected (warmup: ${jitter}ms + 10s) at ${this.config.socketPath}`);

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
