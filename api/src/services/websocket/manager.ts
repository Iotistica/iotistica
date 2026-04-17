/**
 * 🔐 WebSocket Security Architecture
 * ===================================
 * 
 * Defense-in-depth approach with multiple security layers:
 * 
 * 1. JWT Authentication (Upgrade Phase)
 *    - Validates token during WebSocket upgrade
 *    - Rejects connections without valid JWT
 *    - Requires `exp` claim for token expiry tracking
 *    - Prevents unauthorized access to shell, logs, MQTT
 *    Example: wss://api.example.com/ws?token=JWT_HERE&deviceUuid=abc123
 * 
 * 2. Token Expiry Handling
 *    - Automatically closes connection when JWT expires
 *    - Prevents long-lived tokens from granting perpetual access
 *    - Uses server-side timeout to enforce expiry
 *    - Cleans up timeouts on disconnect to prevent memory leaks
 * 
 * 3. Role-Based Access Control
 *    - All shell operations require authenticated user with admin role
 *    - Session ownership validation (user can only access own sessions)
 *    - User ID extraction from JWT token
 * 
 * 4. Input Validation (Zod Schemas)
 *    - Strict message type validation using Zod for all WebSocket messages
 *    - Prevents malicious payload injection and unexpected data types
 *    - Limits string lengths to prevent memory abuse
 *    - Validates UUIDs, session IDs, terminal dimensions
 * 
 * 5. Rate Limiting (Sliding Window)
 *    - Per-client rate limit: 1000 messages per 60 seconds
 *    - Prevents shell spam, log flooding, MQTT stats abuse
 *    - Closes connection immediately when exceeded
 * 
 * 6. Max Payload Size
 *    - WebSocket server limited to 1MB per message
 *    - Prevents memory DoS attacks from huge payloads
 * 
 * 7. Session Management
 *    - Server-side session tracking with user ownership
 *    - Session termination on disconnect
 *    - Audit logging of executed commands
 * 
 * 8. Connection Isolation
 *    - Per-device client tracking (device-specific subscriptions)
 *    - Global client tracking (MQTT stats, separate namespace)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer } from 'http';
import { z } from 'zod';
import { AgentModel, AgentMetricsModel, AgentLogsModel } from '../../db/models';
import logger from '../../utils/logger';
import { fetch } from 'undici';
import { sessionManager } from '../remote/session-manager';
import { agentMetricsPattern, getTenantId, tenantPrefix } from '../../redis/tenant-keys';
import { verifyToken, type JWTPayload } from '../../middleware/jwt-auth';
import {
  WebSocketClient,
  WebSocketMessage,
  CreateSessionSchema,
  AttachSessionSchema,
  DetachSessionSchema,
  TerminateSessionSchema,
  ClearAllSessionsSchema,
  ListSessionsSchema,
  ShellInputSchema,
  ResizeSessionSchema,
  LegacyShellSchema,
  ShellHandler,
} from '../remote/shell';

/**
 * 🔐 Zod Validation Schemas for WebSocket Messages
 * Prevents malicious payload injection, unexpected data types, and memory abuse
 */

// String channel names with length limit (prevents memory abuse via huge strings)
const ChannelSchema = z.enum(['system-info', 'history', 'network-interfaces', 'logs', 'shell', 'mqtt-stats', 'mqtt-topics']);

// Global channel schema
const GlobalChannelSchema = z.enum(['mqtt-stats', 'mqtt-topics']);

// Service name validation (alphanumeric, hyphens, underscores)
const ServiceNameSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/).min(1).max(100);

// Message type validators
const SubscribeSchema = z.object({
  type: z.literal('subscribe'),
  channel: ChannelSchema,
  serviceName: ServiceNameSchema.optional(),
});

const UnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  channel: ChannelSchema,
});

const PingSchema = z.object({
  type: z.literal('ping'),
});

// Shell schemas (CreateSessionSchema, AttachSessionSchema, etc.) are imported from ../websocket/shell

// Union of all valid device message schemas
const DeviceMessageSchema = z.union([
  SubscribeSchema,
  UnsubscribeSchema,
  CreateSessionSchema,
  AttachSessionSchema,
  DetachSessionSchema,
  TerminateSessionSchema,
  ClearAllSessionsSchema,
  ListSessionsSchema,
  ShellInputSchema,
  ResizeSessionSchema,
  LegacyShellSchema,
  PingSchema,
]);

// Global message schemas
const GlobalSubscribeSchema = z.object({
  type: z.literal('subscribe'),
  channel: GlobalChannelSchema,
});

const GlobalUnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  channel: GlobalChannelSchema,
});

const GlobalPingSchema = z.object({
  type: z.literal('ping'),
});

const GlobalMessageSchema = z.union([
  GlobalSubscribeSchema,
  GlobalUnsubscribeSchema,
  GlobalPingSchema,
]);

export class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, WebSocketClient> = new Map();
  private deviceClients: Map<string, Set<WebSocket>> = new Map();
  private deviceIntervals: Map<string, Map<string, NodeJS.Timeout>> = new Map();
  private globalClients: Set<WebSocket> = new Set(); // Global connections for MQTT stats
  private globalIntervals: Map<string, NodeJS.Timeout> = new Map(); // Global subscription intervals (e.g., MQTT stats)
  private mqttMonitor: any = null; // MQTTMonitorService instance
  private mqttManager: any = null; // MQTT Manager instance for publishing commands
  private redisClient: any = null; // Redis client for pub/sub
  private redisSubscriber: any = null; // Separate Redis subscriber client (required by ioredis)
  private redisRealtimeEnabled = false; // True only when Redis pub/sub subscriptions are active
  private redisSubscriptions: Map<string, Set<WebSocket>> = new Map(); // Track Redis subscriptions per device

  private shellHandler: ShellHandler = new ShellHandler({
    send: (ws, message) => this.send(ws, message),
    broadcast: (deviceUuid, message) => this.broadcast(deviceUuid, message),
    getUserIdentifier: (user) => this.getUserIdentifier(user),
  });

  // Normalize user identifier across token formats (legacy HS256, Auth0-minted, etc.)
  private getUserIdentifier(user: JWTPayload | null | undefined): string {
    if (!user) return 'unknown';
    return String(user.userId ?? user.sub ?? 'unknown');
  }
  
  // Metrics batching buffers (per device)
  private metricsBuffers: Map<string, Array<any>> = new Map(); // deviceUuid -> metrics array
  private flushIntervals: Map<string, NodeJS.Timeout> = new Map(); // deviceUuid -> flush interval
  private readonly BATCH_FLUSH_INTERVAL_MS = 10000; // 10 seconds
  
  // 🔐 Rate limiting (sliding window) - prevents shell/logs/MQTT abuse
  private readonly RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 second window
  private readonly RATE_LIMIT_MAX_MESSAGES = 1000; // max 1000 messages per window

  setMqttMonitor(monitor: any): void {
    this.mqttMonitor = monitor;
    logger.debug('MQTT Monitor instance set');
  }

  setMqttManager(manager: any): void {
    this.mqttManager = manager;
    this.shellHandler.setMqttManager(manager);
  }

  /**
   * 🔐 Check and enforce rate limits on WebSocket client using sliding window
   * Prevents shell/logs/MQTT abuse by closing connections that exceed limits
   * @returns true if within limits, false if rate limit exceeded (connection will be closed)
   */
  private checkRateLimit(client: WebSocketClient): boolean {
    const now = Date.now();
    
    // Remove timestamps outside the sliding window
    while (client.messageTimestamps.length > 0 && client.messageTimestamps[0]! < now - this.RATE_LIMIT_WINDOW_MS) {
      client.messageTimestamps.shift();
    }
    
    // Check if exceeds limit
    if (client.messageTimestamps.length >= this.RATE_LIMIT_MAX_MESSAGES) {
      logger.warn(` 🔐 Rate limit exceeded for ${client.deviceUuid ? `device ${client.deviceUuid.substring(0, 8)}...` : 'global client'} (user: ${client.user?.userId || 'unknown'})`);
      logger.warn(` 🔐 Messages in window: ${client.messageTimestamps.length}, limit: ${this.RATE_LIMIT_MAX_MESSAGES} per ${this.RATE_LIMIT_WINDOW_MS}ms`);
      
      // Close connection
      client.ws.close(1008, 'Rate limit exceeded');
      return false;
    }
    
    // Add current timestamp
    client.messageTimestamps.push(now);
    return true;
  }
  async initializeRedis(): Promise<void> {
    // Prevent duplicate initialization
    if (this.redisSubscriber) {
      logger.debug('Redis already initialized, skipping');
      return;
    }
    
    try {
      const { redisClient } = await import('../../redis/client');
      const { getRedisSubscriber } = await import('../../redis/client-factory');
      
      this.redisClient = redisClient;
      
      // Get dedicated subscriber client from factory
      this.redisSubscriber = getRedisSubscriber();
      
      // Subscribe to tenant-scoped patterns (primary) and legacy patterns (fallback)
      // to keep compatibility during migration.
      const tenantId = getTenantId();
      const tenantMetricsPattern = agentMetricsPattern(tenantId);
      const tenantLogsPattern = `${tenantPrefix(tenantId)}:device:*:logs`;
      const legacyMetricsPattern = 'device:*:metrics';
      const legacyLogsPattern = 'device:*:logs';

      await this.redisSubscriber.psubscribe(
        tenantMetricsPattern,
        tenantLogsPattern,
        legacyMetricsPattern,
        legacyLogsPattern,
      );
      
      //Handle incoming messages
      this.redisSubscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
        try {
          const data = JSON.parse(message);
          let uuid: string | null = null;
          let channelType: 'metrics' | 'logs' | null = null;

          // Tenant format: tenant:{tenantId}:device:{uuid}:{metrics|logs}
          const tenantMatch = channel.match(/^tenant:\{[^}]+\}:device:([^:]+):(metrics|logs)$/);
          if (tenantMatch) {
            uuid = tenantMatch[1];
            channelType = tenantMatch[2] as 'metrics' | 'logs';
          } else {
            // Legacy format: device:{uuid}:{metrics|logs}
            const legacyMatch = channel.match(/^device:([^:]+):(metrics|logs)$/);
            if (legacyMatch) {
              uuid = legacyMatch[1];
              channelType = legacyMatch[2] as 'metrics' | 'logs';
            }
          }

          if (!uuid || !channelType) {
            logger.debug(`Skipping Redis message with unrecognized channel format: ${channel}`);
            return;
          }

          if (channelType === 'metrics') {
            this.handleRedisMetrics(uuid, data.metrics ?? data);
          } else if (channelType === 'logs') {
            this.handleRedisLogs(uuid, data.logs ?? data);
          }
        } catch (error) {
          logger.error(' Error parsing Redis message:', error);
        }
      });
      
      // Handle subscriber errors
      this.redisSubscriber.on('error', (error: Error) => {
        logger.error(' Redis subscriber error:', error);
      });
      
      this.redisSubscriber.on('ready', () => {
        logger.debug('Redis subscriber connected and ready');
      });
      this.redisRealtimeEnabled = true;
      
      logger.debug('Redis pub/sub integration initialized');
      logger.debug({ tenantMetricsPattern, tenantLogsPattern, legacyMetricsPattern, legacyLogsPattern }, 'Subscribed to patterns');
    } catch (error) {
      this.redisRealtimeEnabled = false;
      this.redisClient = null;
      logger.error('Failed to initialize Redis pub/sub:', error);
      logger.debug('Falling back to database polling');
    }
  }

  /**
   * Handle incoming Redis pub/sub metrics
   * Called when device:{uuid}:metrics channel receives data
   * Buffers metrics and flushes in batches every 10 seconds
   */
  private handleRedisMetrics(deviceUuid: string, metrics: any): void {
    // Transform metrics to dashboard history format
    // Send ISO timestamp and let client format it (avoids timezone mismatches)
    const time = new Date().toISOString();
    
    const dataPoint = {
      time,
      cpu: Math.round(parseFloat(metrics.cpu_usage) || 0),
      memory_used: Math.round(parseFloat(metrics.memory_usage) || 0), // Already in MB from database
      memory_available: Math.round((parseFloat(metrics.memory_total) || 0) - (parseFloat(metrics.memory_usage) || 0)), // Already in MB
      network_download: 0, // Network metrics coming in future phase
      network_upload: 0,
    };
    
    // Add to buffer
    if (!this.metricsBuffers.has(deviceUuid)) {
      this.metricsBuffers.set(deviceUuid, []);
    }
    this.metricsBuffers.get(deviceUuid)!.push(dataPoint);
    
    // Start flush interval if not already running
    if (!this.flushIntervals.has(deviceUuid)) {
      const interval = setInterval(() => {
        this.flushMetricsBatch(deviceUuid);
      }, this.BATCH_FLUSH_INTERVAL_MS);
      this.flushIntervals.set(deviceUuid, interval);
      logger.debug(`Started batch flush interval for device ${deviceUuid.substring(0, 8)}...`);
    }
    
    // Update network interfaces if present (send immediately, not batched)
    if (metrics.network_interfaces) {
      const interfaces = metrics.network_interfaces.map((iface: any) => ({
        id: iface.name,
        name: iface.name,
        type: iface.type || 'ethernet',
        ipAddress: iface.ip4,
        ip4: iface.ip4,
        ip6: iface.ip6,
        mac: iface.mac,
        status: iface.operstate === 'up' ? 'connected' : 'disconnected',
        operstate: iface.operstate,
        default: iface.default,
        virtual: iface.virtual,
        ...(iface.ssid && { ssid: iface.ssid }),
        ...(iface.signalLevel && { signal: iface.signalLevel }),
      }));
      
      this.broadcast(deviceUuid, {
        type: 'network-interfaces',
        deviceUuid,
        data: { interfaces },
        timestamp: new Date().toISOString(),
        source: 'redis',
      });
    }
  }

  /**
   * Handle incoming Redis pub/sub logs
   * Called when device:{uuid}:logs channel receives data
   * Immediately broadcasts to WebSocket clients (no batching for logs)
   */
  private handleRedisLogs(deviceUuid: string, logs: any[]): void {
    if (!logs || logs.length === 0) {
      return;
    }
    
    logger.debug(`Received ${logs.length} logs from Redis for ${deviceUuid.substring(0, 8)}...`);
    
    // Broadcast immediately to all clients subscribed to logs channel
    this.broadcast(deviceUuid, {
      type: 'logs',
      deviceUuid,
      data: { logs },
      timestamp: new Date().toISOString(),
      source: 'redis', // Indicate this came from Redis (real-time)
    });
  }

  /**
   * Flush batched metrics to WebSocket clients
   * Called every BATCH_FLUSH_INTERVAL_MS (10 seconds)
   */
  private flushMetricsBatch(deviceUuid: string): void {
    const buffer = this.metricsBuffers.get(deviceUuid);
    
    if (!buffer || buffer.length === 0) {
      return; // Nothing to flush
    }
    
    // Transform buffer to dashboard format
    const historyData = {
      cpu: buffer.map(point => ({ time: point.time, value: point.cpu })),
      memory: buffer.map(point => ({ 
        time: point.time, 
        used: point.memory_used, 
        available: point.memory_available 
      })),
      network: buffer.map(point => ({ 
        time: point.time, 
        download: point.network_download, 
        upload: point.network_upload 
      })),
    };
    
    logger.debug(`Flushing ${buffer.length} metrics for device ${deviceUuid.substring(0, 8)}...`);
    
    // Broadcast batched data
    this.broadcast(deviceUuid, {
      type: 'history',
      deviceUuid,
      data: historyData,
      timestamp: new Date().toISOString(),
      source: 'redis', // Indicate this came from Redis (real-time)
    });
    
    // Clear buffer
    this.metricsBuffers.set(deviceUuid, []);
  }

  initialize(server: HTTPServer): void {
    // 🔐 Initialize WebSocket server with security constraints
    // maxPayload: 1MB limit prevents memory DoS attacks
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 1024 * 1024, // 1MB - prevents memory DoS
    });

    // Handle upgrade requests
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      
      if (url.pathname === '/ws') {
        const deviceUuid = url.searchParams.get('deviceUuid');
        const type = url.searchParams.get('type'); // 'device' or 'global'
        const token = url.searchParams.get('token');
        
        // 🔐 JWT Authentication - validate token for all connections
        let user: JWTPayload | null = null;
        
        if (!token) {
          logger.warn(' WebSocket connection rejected: missing JWT token');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        try {
          user = verifyToken(token);

          if (user.type !== 'access') {
            logger.warn(' WebSocket connection rejected: invalid token type');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          
          // 🔐 Validate token has expiry claim (required for security)
          if (!user.exp) {
            logger.warn(' WebSocket connection rejected: JWT missing exp claim');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          
          // Calculate token expiry time
          const expiresIn = user.exp * 1000 - Date.now();
          if (expiresIn < 0) {
            logger.warn(' WebSocket connection rejected: JWT token already expired');
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          
          logger.debug(`WebSocket JWT verified for user ${this.getUserIdentifier(user)}, expires in ${Math.round(expiresIn / 1000)}s`);
          
          // Store token expiry for later use in connection handlers
          (request as any).tokenExpiryMs = expiresIn;
        } catch (error) {
          logger.warn(` WebSocket connection rejected: invalid JWT - ${(error as Error).message}`);
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // Allow global connections without deviceUuid, but device connections require it
        if (!deviceUuid && type !== 'global') {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }

        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          const tokenExpiryMs = (request as any).tokenExpiryMs;
          if (type === 'global') {
            this.handleGlobalConnection(ws, user!, tokenExpiryMs);
          } else {
            this.handleConnection(ws, deviceUuid!, user!, tokenExpiryMs);
          }
        });
      } else {
        socket.destroy();
      }
    });

    logger.debug('WebSocket server initialized');
  }

  private handleConnection(ws: WebSocket, deviceUuid: string, user: JWTPayload, tokenExpiryMs?: number): void {
    logger.info(`Device connected: ${deviceUuid.substring(0, 8)}... (user: ${this.getUserIdentifier(user)})`);

    const client: WebSocketClient = {
      ws,
      deviceUuid,
      user,
      subscriptions: new Set(),
      intervals: new Map(),
      messageTimestamps: [], // 🔐 Initialize rate limit tracking
    };

    this.clients.set(ws, client);

    // Track clients per device
    if (!this.deviceClients.has(deviceUuid)) {
      this.deviceClients.set(deviceUuid, new Set());
    }
    this.deviceClients.get(deviceUuid)!.add(ws);

    // 🔐 Setup token expiry handler - auto-close connection when JWT expires
    if (tokenExpiryMs && tokenExpiryMs > 0) {
      const expiryTimeout = setTimeout(() => {
        logger.info(` 🔐 JWT expired for user ${user.userId}, closing connection for device ${deviceUuid.substring(0, 8)}...`);
        ws.close(1008, 'Token expired');
      }, tokenExpiryMs);
      
      client.tokenExpiryTimeout = expiryTimeout;
    } else {
      logger.debug(`Token expiry not set for device connection (user: ${this.getUserIdentifier(user)})`);
    }

    // Send welcome message
    this.send(ws, {
      type: 'connected',
      deviceUuid,
      message: 'WebSocket connection established',
    });

    ws.on('message', (data) => {
      try {
        const rawMessage = JSON.parse(data.toString());
        
        // 🔐 Validate message schema to prevent injection attacks and memory abuse
        const validationResult = DeviceMessageSchema.safeParse(rawMessage);
        if (!validationResult.success) {
          logger.warn(` 🔐 Invalid message schema from device connection:`, {
            errors: validationResult.error.errors,
            messageType: rawMessage.type,
          });
          this.send(client.ws, {
            type: 'error',
            message: `Invalid message format: ${validationResult.error.errors[0]?.message || 'unknown error'}`,
          });
          return;
        }
        
        const message = validationResult.data as WebSocketMessage;
        logger.debug(`Received message: ${message.type}`);
        
        // 🔐 Check rate limits (prevents shell/logs/MQTT abuse)
        if (!this.checkRateLimit(client)) {
          return; // Connection closed, exit
        }
        
        this.handleMessage(client, message);
      } catch (error) {
        logger.error(' Failed to parse message:', error);
        this.send(client.ws, {
          type: 'error',
          message: 'Failed to parse message',
        });
      }
    });

    ws.on('close', () => {
      this.handleDisconnect(client);
    });

    ws.on('error', (error) => {
      logger.error(' Connection error:', error);
      this.handleDisconnect(client);
    });
  }

  private handleGlobalConnection(ws: WebSocket, user: JWTPayload, tokenExpiryMs?: number): void {
    logger.info(`✅ Global client connected: ${this.getUserIdentifier(user)}`);

    const client: WebSocketClient = {
      ws,
      deviceUuid: null, // Global connection
      user,
      subscriptions: new Set(),
      intervals: new Map(),
      messageTimestamps: [], // 🔐 Initialize rate limit tracking
    };

    this.clients.set(ws, client);
    this.globalClients.add(ws);

    // 🔐 Setup token expiry handler - auto-close connection when JWT expires
    if (tokenExpiryMs && tokenExpiryMs > 0) {
      const expiryTimeout = setTimeout(() => {
        logger.info(` 🔐 JWT expired for user ${user.userId}, closing global connection`);
        ws.close(1008, 'Token expired');
      }, tokenExpiryMs);
      
      client.tokenExpiryTimeout = expiryTimeout;
    } else {
      logger.debug(`Token expiry not set for global connection (user: ${this.getUserIdentifier(user)})`);
    }

    // Send welcome message
    this.send(ws, {
      type: 'connected',
      message: 'Global WebSocket connection established (MQTT stats)',
    });

    ws.on('message', (data) => {
      try {
        const rawMessage = JSON.parse(data.toString());
        
        // 🔐 Validate global message schema to prevent injection attacks and memory abuse
        const validationResult = GlobalMessageSchema.safeParse(rawMessage);
        if (!validationResult.success) {
          logger.warn(` 🔐 Invalid message schema from global connection:`, {
            errors: validationResult.error.errors,
            messageType: rawMessage.type,
          });
          this.send(client.ws, {
            type: 'error',
            message: `Invalid message format: ${validationResult.error.errors[0]?.message || 'unknown error'}`,
          });
          return;
        }
        
        const message = validationResult.data as WebSocketMessage;
        logger.debug(`Received global message: ${message.type}`);
        
        // 🔐 Check rate limits (prevents MQTT stats abuse)
        if (!this.checkRateLimit(client)) {
          return; // Connection closed, exit
        }
        
        this.handleGlobalMessage(client, message);
      } catch (error) {
        logger.error(' Failed to parse message:', error);
        this.send(client.ws, {
          type: 'error',
          message: 'Failed to parse message',
        });
      }
    });

    ws.on('close', () => {
      this.handleGlobalDisconnect(client);
    });

    ws.on('error', (error) => {
      logger.error(' Global connection error:', error);
      this.handleGlobalDisconnect(client);
    });
  }

  private handleGlobalMessage(client: WebSocketClient, message: WebSocketMessage): void {
    switch (message.type) {
      case 'subscribe':
        if (message.channel) {
          this.handleGlobalSubscribe(client, message.channel);
        }
        break;

      case 'unsubscribe':
        if (message.channel) {
          this.handleGlobalUnsubscribe(client, message.channel);
        }
        break;

      case 'ping':
        this.send(client.ws, { type: 'pong' });
        break;

      default:
        logger.warn(' Unknown message type:', message.type);
    }
  }

  private handleGlobalSubscribe(client: WebSocketClient, channel: string): void {
    logger.debug(`Global client subscribed to ${channel}`);
    
    client.subscriptions.add(channel);

    // Check if this is the first client subscribing to this global channel
    const hasOtherSubscribers = Array.from(this.globalClients).some(
      ws => ws !== client.ws && this.clients.get(ws)?.subscriptions.has(channel)
    );

    if (!hasOtherSubscribers) {
      this.startGlobalDataStream(channel);
    }

    // Send initial data immediately
    this.sendGlobalChannelData(channel);
  }

  private handleGlobalUnsubscribe(client: WebSocketClient, channel: string): void {
    logger.debug(`Global client unsubscribed from ${channel}`);
    
    client.subscriptions.delete(channel);

    // Stop stream if no more clients are subscribed
    const hasOtherSubscribers = Array.from(this.globalClients).some(
      ws => this.clients.get(ws)?.subscriptions.has(channel)
    );

    if (!hasOtherSubscribers) {
      this.stopGlobalDataStream(channel);
    }
  }

  private handleGlobalDisconnect(client: WebSocketClient): void {
    logger.debug(`Global client disconnected`);

    // 🔐 Clear token expiry timeout to prevent memory leaks
    if (client.tokenExpiryTimeout) {
      clearTimeout(client.tokenExpiryTimeout);
    }

    this.globalClients.delete(client.ws);
    this.clients.delete(client.ws);

    // Stop streams if no more subscribers
    client.subscriptions.forEach(channel => {
      const hasOtherSubscribers = Array.from(this.globalClients).some(
        ws => this.clients.get(ws)?.subscriptions.has(channel)
      );

      if (!hasOtherSubscribers) {
        this.stopGlobalDataStream(channel);
      }
    });

    logger.debug(`Total clients: ${this.clients.size}`);
  }

  private handleMessage(client: WebSocketClient, message: WebSocketMessage): void {
    switch (message.type) {
      case 'subscribe':
        if (message.channel) {
          // For logs channel, store serviceName for filtering
          if (message.channel === 'logs' && message.serviceName) {
            client.serviceName = message.serviceName;
          }
          this.handleSubscribe(client, message.channel);
        }
        break;

      case 'unsubscribe':
        if (message.channel) {
          this.handleUnsubscribe(client, message.channel);
        }
        break;

      case 'create-session':
        this.shellHandler.handleCreateSession(client, message);
        break;

      case 'attach-session':
        this.shellHandler.handleAttachSession(client, message);
        break;

      case 'detach-session':
        this.shellHandler.handleDetachSession(client, message);
        break;

      case 'terminate-session':
        this.shellHandler.handleTerminateSession(client, message);
        break;

      case 'clear-all-sessions':
        this.shellHandler.handleClearAllSessions(client, message);
        break;

      case 'list-sessions':
        this.shellHandler.handleListSessions(client, message);
        break;

      case 'shell-input':
        this.shellHandler.handleShellInput(client, message);
        break;

      case 'resize-session':
        this.shellHandler.handleResizeSession(client, message);
        break;

      case 'shell':
        // Legacy support: Forward shell commands to device via MQTT
        logger.debug('SHELL: Received legacy shell command', {
          deviceUuid: client.deviceUuid?.substring(0, 8) + '...',
          action: message.data?.action,
          hasData: !!message.data?.data,
        });
        if (client.deviceUuid && message.data) {
          this.shellHandler.handleShellCommand(client.deviceUuid, message.data);
        }
        break;

      case 'ping':
        this.send(client.ws, { type: 'pong' });
        break;

      default:
        logger.debug('Unknown message type:', message.type);
    }
  }

  private handleSubscribe(client: WebSocketClient, channel: string): void {
    logger.debug(`Subscribed to ${channel}`);
    
    if (channel === 'shell') {
      logger.debug('SHELL: Client subscribed to shell channel', {
        deviceUuid: client.deviceUuid?.substring(0, 8) + '...',
        channel
      });
    }
    
    client.subscriptions.add(channel);

    // Check if this is the first client subscribing to this channel for this device
    const deviceClients = this.deviceClients.get(client.deviceUuid);
    const isFirstSubscription = !Array.from(deviceClients || []).some(ws => {
      const otherClient = this.clients.get(ws);
      return otherClient !== client && otherClient?.subscriptions.has(channel);
    });

    // Start data streams if this is the first subscription
    if (isFirstSubscription) {
      this.startDataStream(client.deviceUuid, channel);
    }

    // Send initial data immediately for channels with data fetchers.
    // Shell is command/stream oriented and has no initial snapshot endpoint.
    if (channel !== 'shell') {
      this.sendChannelData(client.deviceUuid, channel);
    }

    // Acknowledge subscription
    this.send(client.ws, {
      type: 'subscribed',
      channel,
      deviceUuid: client.deviceUuid,
    });
  }

  private handleUnsubscribe(client: WebSocketClient, channel: string): void {
    logger.debug(`Unsubscribed from ${channel}`);
    
    client.subscriptions.delete(channel);

    // Check if any other clients are still subscribed to this channel for this device
    const deviceClients = this.deviceClients.get(client.deviceUuid);
    const hasOtherSubscribers = Array.from(deviceClients || []).some(ws => {
      const otherClient = this.clients.get(ws);
      return otherClient?.subscriptions.has(channel);
    });

    // Stop data stream if no more subscribers
    if (!hasOtherSubscribers) {
      this.stopDataStream(client.deviceUuid, channel);
    }

    // Acknowledge unsubscription
    this.send(client.ws, {
      type: 'unsubscribed',
      channel,
      deviceUuid: client.deviceUuid,
    });
  }

  private startDataStream(deviceUuid: string, channel: string): void {
    if (!this.deviceIntervals.has(deviceUuid)) {
      this.deviceIntervals.set(deviceUuid, new Map());
    }

    const intervals = this.deviceIntervals.get(deviceUuid)!;

    // Don't start if already running
    if (intervals.has(channel)) {
      return;
    }

    // Shell channel uses MQTT pub/sub only (no polling)
    if (channel === 'shell') {
      logger.debug(`Shell channel active (MQTT-based)`);
      return;
    }

    // For real-time channels (history, network-interfaces, logs), use Redis pub/sub if available
    // Only fall back to polling if Redis unavailable
    const redisChannels = ['history', 'network-interfaces', 'logs'];
    if (redisChannels.includes(channel) && this.redisRealtimeEnabled) {
      logger.debug(`Using Redis pub/sub for real-time updates`);
      // No polling needed - Redis will push updates
      // But still send initial data immediately
      this.sendChannelData(deviceUuid, channel);
      return;
    }

    // For non-Redis channels or if Redis unavailable, use polling
    let intervalTime: number;
    switch (channel) {
      case 'system-info':
        intervalTime = 30000; // 30 seconds
        break;
      case 'history':
        intervalTime = 30000; // 30 seconds (fallback)
        break;
      case 'network-interfaces':
        intervalTime = 30000; // 30 seconds (fallback)
        break;
      case 'logs':
        intervalTime = 2000; // 2 seconds for real-time logs (fallback)
        break;
      default:
        logger.debug(`Unknown channel: ${channel}`);
        return;
    }

    const interval = setInterval(() => {
      this.sendChannelData(deviceUuid, channel);
    }, intervalTime);

    intervals.set(channel, interval);
    logger.debug(`Started ${channel} stream (interval: ${intervalTime}ms)`);
  }

  private stopDataStream(deviceUuid: string, channel: string): void {
    const intervals = this.deviceIntervals.get(deviceUuid);
    if (intervals?.has(channel)) {
      clearInterval(intervals.get(channel)!);
      intervals.delete(channel);
      logger.debug(`Stopped ${channel} stream`);

      // Clean up device intervals map if empty
      if (intervals.size === 0) {
        this.deviceIntervals.delete(deviceUuid);
      }
    }
  }

  private startGlobalDataStream(channel: string): void {
    // Don't start if already running
    if (this.globalIntervals.has(channel)) {
      return;
    }

    let intervalTime: number;
    switch (channel) {
      case 'mqtt-stats':
        intervalTime = 5000; // 5 seconds (same as HTTP polling)
        break;
      case 'mqtt-topics':
        intervalTime = 10000; // 10 seconds
        break;
      default:
        logger.debug(`Unknown global channel: ${channel}`);
        return;
    }

    const interval = setInterval(() => {
      this.sendGlobalChannelData(channel);
    }, intervalTime);

    this.globalIntervals.set(channel, interval);
    logger.debug(`Started global ${channel} stream (interval: ${intervalTime}ms)`);
  }

  private stopGlobalDataStream(channel: string): void {
    if (this.globalIntervals.has(channel)) {
      clearInterval(this.globalIntervals.get(channel)!);
      this.globalIntervals.delete(channel);
      logger.debug(`Stopped global ${channel} stream`);
    }
  }

  private async sendGlobalChannelData(channel: string): Promise<void> {
    try {
      let data: any;

      switch (channel) {
        case 'mqtt-stats':
          data = await this.fetchMqttStats();
          break;
        case 'mqtt-topics':
          data = await this.fetchMqttTopics();
          break;
        default:
          logger.debug(`Unknown global channel: ${channel}`);
          return;
      }

      if (data) {
        this.broadcastGlobal({
          type: channel,
          data,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error(` Error fetching ${channel} data:`, error);
    }
  }

  private async fetchMqttStats(): Promise<any> {
    try {
      // Fetch from mqtt-exporter via our proxy endpoint
      const response = await fetch('http://localhost:3002/api/v1/mqtt/metrics');
      
      if (!response.ok) {
        logger.debug(`Failed to fetch MQTT metrics: ${response.status}`);
        return null;
      }
      
      const data = await response.json();
      return data;
    } catch (error: any) {
      logger.error(' Error fetching MQTT stats:', error);
      return null;
    }
  }

  private async fetchMqttTopics(): Promise<any> {
    try {
      // Fetch from our own API endpoint which queries the database (with decompression)
      const response = await fetch('http://localhost:3002/api/v1/mqtt/topics?limit=50&decompress=true');
      
      if (!response.ok) {
        logger.debug(`Failed to fetch MQTT topics: ${response.status}`);
        return null;
      }
      
      const data = await response.json();
      return data;
    } catch (error: any) {
      logger.error(' Error fetching MQTT topics:', error);
      return null;
    }
  }

  private broadcastGlobal(message: WebSocketMessage): void {
    this.globalClients.forEach(ws => {
      const client = this.clients.get(ws);
      if (client && message.type && client.subscriptions.has(message.type)) {
        this.send(ws, message);
      }
    });
  }

  private async sendChannelData(deviceUuid: string, channel: string): Promise<void> {
    try {
      let data: any;

      // For logs channel, send data to each client individually based on their serviceName filter
      if (channel === 'logs') {
        const deviceClients = this.deviceClients.get(deviceUuid);
        if (deviceClients) {
          for (const ws of deviceClients) {
            const client = this.clients.get(ws);
            if (client?.subscriptions.has('logs')) {
              const logsData = await this.fetchLogs(deviceUuid, client.serviceName);
              if (logsData) {
                this.send(ws, {
                  type: 'logs',
                  deviceUuid,
                  data: logsData,
                  timestamp: new Date().toISOString(),
                });
              }
            }
          }
        }
        return;
      }

      // For other channels, fetch once and broadcast to all
      switch (channel) {
        case 'system-info':
          data = await this.fetchSystemInfo(deviceUuid);
          break;
        case 'history':
          data = await this.fetchMetricsHistory(deviceUuid);
          break;
        case 'network-interfaces':
          data = await this.fetchNetworkInterfaces(deviceUuid);
          break;
        default:
          logger.warn(` Unknown channel: ${channel}`);
          return;
      }

      if (data) {
        this.broadcast(deviceUuid, {
          type: channel,
          deviceUuid,
          data,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.error(` Error fetching ${channel} data:`, error);
    }
  }

  private async fetchSystemInfo(deviceUuid: string): Promise<any> {
    try {
      const device = await AgentModel.getByUuid(deviceUuid);
      if (!device) return null;

      return {
        os: device.os_version || 'Unknown',
        architecture: 'Unknown', // Not stored in DB yet
        uptime: 0, // Not stored in DB yet
        hostname: device.name || 'Unknown',
        ipAddress: device.ip_address || 'Unknown',
        macAddress: device.mac_address || 'Unknown',
      };
    } catch (error) {
      logger.error(' Error fetching system info:', error);
      return null;
    }
  }

  private async fetchMetricsHistory(deviceUuid: string): Promise<any> {
    try {
      // Fetch last 30 minutes of data (not 30 rows)
      // This ensures we get the correct number of points based on agent reporting interval
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const metrics = await AgentMetricsModel.getRecentByTime(deviceUuid, thirtyMinutesAgo);

      logger.debug(`Fetched ${metrics.length} metrics (last 30 min)`);

      // Log time range of fetched data
      if (metrics.length > 0) {
        const firstTime = new Date(metrics[0].recorded_at);
        const lastTime = new Date(metrics[metrics.length - 1].recorded_at);
        const spanMinutes = (lastTime.getTime() - firstTime.getTime()) / 60000;
        logger.debug(`Time range: ${firstTime.toISOString()} to ${lastTime.toISOString()} (${Math.round(spanMinutes)} minutes)`);
      }

      // Transform to dashboard format (same as original App.tsx HTTP polling logic)
      const cpu: Array<{ time: string; value: number }> = [];
      const memory: Array<{ time: string; used: number; available: number }> = [];
      const network: Array<{ time: string; download: number; upload: number }> = [];

      // Data is already in chronological order (ASC) from getRecentByTime
      metrics.forEach((m: any) => {
        // Send ISO timestamp and let client format it (avoids timezone mismatches)
        const time = new Date(m.recorded_at).toISOString();

        // CPU data
        cpu.push({
          time,
          value: Math.round(parseFloat(m.cpu_usage) || 0),
        });

        // Memory data (convert bytes to MB) - matches original App.tsx logic
        const memoryUsageMB = Math.round((parseFloat(m.memory_usage) || 0) / 1024 / 1024);
        const memoryTotalMB = (parseFloat(m.memory_total) || 0) / 1024 / 1024;
        const memoryAvailableMB = Math.round(memoryTotalMB - memoryUsageMB);
        
        memory.push({
          time,
          used: memoryUsageMB,
          available: memoryAvailableMB,
        });

        // Network history - placeholder for now since network metrics aren't stored yet
        // This matches the original App.tsx behavior
        network.push({
          time,
          download: 0,
          upload: 0,
        });
      });

      return { cpu, memory, network };
    } catch (error) {
      logger.error(' Error fetching metrics history:', error);
      return null;
    }
  }

  private async fetchNetworkInterfaces(deviceUuid: string): Promise<any> {
    try {
      // Use same logic as HTTP endpoint /api/v1/agents/:uuid/network-interfaces
      const device = await AgentModel.getByUuid(deviceUuid);
      if (!device) return null;

      let interfaces = [];
      
      if (device.network_interfaces) {
        // Parse if it's a string, otherwise use as-is
        const networkData = typeof device.network_interfaces === 'string' 
          ? JSON.parse(device.network_interfaces) 
          : device.network_interfaces;
        
        // Transform to dashboard format (matches HTTP endpoint exactly)
        interfaces = networkData.map((iface: any) => ({
          id: iface.name,
          name: iface.name,
          type: iface.type || 'ethernet',
          ipAddress: iface.ip4,
          ip4: iface.ip4,
          ip6: iface.ip6,
          mac: iface.mac,
          status: iface.operstate === 'up' ? 'connected' : 'disconnected',
          operstate: iface.operstate,
          default: iface.default,
          virtual: iface.virtual,
          // WiFi specific fields
          ...(iface.ssid && { ssid: iface.ssid }),
          ...(iface.signalLevel && { signal: iface.signalLevel }),
        }));
      } else if (device.ip_address) {
        // Fallback: Create a default interface based on device IP (matches HTTP endpoint)
        interfaces.push({
          id: 'eth0',
          name: 'eth0',
          type: 'ethernet',
          ipAddress: device.ip_address,
          ip4: device.ip_address,
          status: device.is_online ? 'connected' : 'disconnected',
          default: true,
          operstate: device.is_online ? 'up' : 'down',
        });
      }

      return { interfaces };
    } catch (error) {
      logger.error(' Error fetching network interfaces:', error);
      return null;
    }
  }

  private async fetchLogs(deviceUuid: string, serviceName?: string): Promise<any> {
    try {
      // Fetch latest logs (limit to 50 per poll to avoid overwhelming the client)
      const logs = await AgentLogsModel.get(deviceUuid, {
        serviceName,
        limit: 50,
        offset: 0,
      });

      logger.debug(`Fetched ${logs.length} log entries`);

      return { logs };
    } catch (error) {
      logger.error('Error fetching logs:', error);
      return null;
    }
  }

  private handleDisconnect(client: WebSocketClient): void {
    logger.info(`❌ Device disconnected: ${client.deviceUuid.substring(0, 8)}...`);

    // 🔐 Clear token expiry timeout to prevent memory leaks
    if (client.tokenExpiryTimeout) {
      clearTimeout(client.tokenExpiryTimeout);
    }

    // CRITICAL: Detach from all sessions this client was attached to
    // This ensures database status is updated when WebSocket closes unexpectedly
    sessionManager.detachClientFromAllSessions(client.ws);

    // Remove from device clients
    const deviceClients = this.deviceClients.get(client.deviceUuid);
    if (deviceClients) {
      deviceClients.delete(client.ws);
      
      // For each subscription, check if we should stop the stream
      client.subscriptions.forEach(channel => {
        const hasOtherSubscribers = Array.from(deviceClients).some(ws => {
          const otherClient = this.clients.get(ws);
          return otherClient?.subscriptions.has(channel);
        });

        if (!hasOtherSubscribers) {
          this.stopDataStream(client.deviceUuid, channel);
        }
      });

      // Clean up device clients map if empty
      if (deviceClients.size === 0) {
        this.deviceClients.delete(client.deviceUuid);
      }
    }

    // Clean up client intervals
    client.intervals.forEach(interval => clearInterval(interval));
    client.intervals.clear();

    // Remove from clients map
    this.clients.delete(client.ws);
  }

  private broadcast(deviceUuid: string, message: WebSocketMessage): void {
    const deviceClients = this.deviceClients.get(deviceUuid);
    if (!deviceClients) {
      logger.debug(`No WebSocket clients for device ${deviceUuid.substring(0, 8)}`);
      return;
    }

    const channel = message.type;
    let sentCount = 0;
    let filteredCount = 0;

    deviceClients.forEach(ws => {
      const client = this.clients.get(ws);
      if (client?.subscriptions.has(channel) && ws.readyState === WebSocket.OPEN) {
        // For logs channel: filter by serviceName if client has a filter
        if (channel === 'logs' && message.data?.logs) {
          const filteredMessage = { ...message };
          
          // If client has serviceName filter, only send matching logs
          if (client.serviceName) {
            const filteredLogs = message.data.logs.filter(
              (log: any) => {
                // Handle both camelCase (from Redis/worker) and snake_case (from database)
                const logService = log.serviceName || log.service_name;
                return logService === client.serviceName;
              }
            );
            
            // Skip if no logs match the filter
            if (filteredLogs.length === 0) {
              filteredCount++;
              return;
            }
            
            filteredMessage.data = { ...message.data, logs: filteredLogs };
          }
          
          this.send(ws, filteredMessage);
        } else {
          this.send(ws, message);
        }
        sentCount++;
      }
    });

    if (channel === 'logs' && message.data?.logs) {
      logger.debug(`📡 Broadcast logs: ${message.data.logs.length} total, sent to ${sentCount} clients, ${filteredCount} filtered out`);
    }
    
    if (channel === 'shell') {
      logger.debug(`SHELL: Broadcast shell output to ${sentCount} client(s)`, {
        deviceUuid: deviceUuid.substring(0, 8) + '...',
        totalClients: deviceClients?.size || 0,
        sentCount,
        outputPreview: message.data?.output?.substring(0, 50)
      });
    }

    if (sentCount > 0) {
      logger.debug(`Broadcasted ${channel} to ${sentCount} client(s)`);
    }
  }

  private send(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  async shutdown(): Promise<void> {
    logger.info(' Shutting down...');

    // Shutdown session manager
    await sessionManager.shutdown();

    // Shutdown shell handler (clears command buffers)
    this.shellHandler.shutdown();

    // Flush any pending metrics before shutdown
    this.metricsBuffers.forEach((buffer, deviceUuid) => {
      if (buffer.length > 0) {
        logger.debug(`Flushing ${buffer.length} pending metrics before shutdown`);
        this.flushMetricsBatch(deviceUuid);
      }
    });

    // Clear batch flush intervals
    this.flushIntervals.forEach(interval => clearInterval(interval));
    this.flushIntervals.clear();
    this.metricsBuffers.clear();

    // Disconnect Redis subscriber
    if (this.redisSubscriber) {
      this.redisSubscriber.disconnect();
      logger.info(' Redis subscriber disconnected');
    }

    // Clear all intervals
    this.deviceIntervals.forEach((intervals) => {
      intervals.forEach(interval => clearInterval(interval));
    });
    this.deviceIntervals.clear();

    // Clear global intervals
    this.globalIntervals.forEach(interval => clearInterval(interval));
    this.globalIntervals.clear();

    // Close all connections
    this.clients.forEach((client) => {
      client.ws.close();
    });

    this.clients.clear();
    this.deviceClients.clear();
    this.globalClients.clear();
    this.redisSubscriptions.clear();

    if (this.wss) {
      this.wss.close();
    }

    logger.info(' Shutdown complete');
  }
}

export const websocketManager = new WebSocketManager();
