import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer } from 'http';
import { DeviceModel, DeviceMetricsModel, DeviceLogsModel } from '../db/models';
import logger from '../utils/logger';
import fetch from 'node-fetch';
import { sessionManager } from './session-manager';
import { query } from '../db/connection';

interface WebSocketClient {
  ws: WebSocket;
  deviceUuid: string | null; // null for global connections (e.g., MQTT stats)
  subscriptions: Set<string>;
  intervals: Map<string, NodeJS.Timeout>;
  serviceName?: string; // For logs channel - which service to stream logs for
  redisSubscription?: boolean; // Track if subscribed to Redis pub/sub
}

interface WebSocketMessage {
  type: string;
  deviceUuid?: string;
  channel?: string;
  data?: any;
  timestamp?: string;
  message?: string;
  serviceName?: string; // For logs channel - which service to filter logs by
  source?: string; // Indicate source: 'redis' (real-time) or 'database' (polling)
}

export class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, WebSocketClient> = new Map();
  private deviceClients: Map<string, Set<WebSocket>> = new Map();
  private deviceIntervals: Map<string, Map<string, NodeJS.Timeout>> = new Map();
  private globalClients: Set<WebSocket> = new Set(); // Global connections for MQTT stats
  private globalIntervals: Map<string, NodeJS.Timeout> = new Map(); // Global intervals
  private mqttMonitor: any = null; // MQTTMonitorService instance
  private mqttManager: any = null; // MQTT Manager instance for publishing commands
  private redisClient: any = null; // Redis client for pub/sub
  private redisSubscriber: any = null; // Separate Redis subscriber client (required by ioredis)
  private redisSubscriptions: Map<string, Set<WebSocket>> = new Map(); // Track Redis subscriptions per device
  
  // Metrics batching buffers (per device)
  private metricsBuffers: Map<string, Array<any>> = new Map(); // deviceUuid -> metrics array
  private flushIntervals: Map<string, NodeJS.Timeout> = new Map(); // deviceUuid -> flush interval
  private readonly BATCH_FLUSH_INTERVAL_MS = 10000; // 10 seconds
  
  // Shell command buffers (per session) - for audit logging
  private commandBuffers: Map<string, string> = new Map(); // sessionId -> accumulated command string
  
  // Track if MQTT shell listeners are already registered to prevent duplicates
  private shellListenersRegistered = false;

  setMqttMonitor(monitor: any): void {
    this.mqttMonitor = monitor;
    logger.info(' MQTT Monitor instance set');
  }

  setMqttManager(manager: any): void {
    this.mqttManager = manager;
    
    // Only register shell listeners once, ever
    if (!this.shellListenersRegistered && manager) {
      this.shellListenersRegistered = true;
      
      // Subscribe to shell-output topic
      manager.subscribeTopic('iot/device/+/agent/shell-output', 1);
      
      // Register ONE event listener for agent messages (shell-output)
      manager.on('agent', (payload: any) => {
        if (payload.subTopic === 'shell-output') {
          this.handleShellOutput(payload.deviceUuid, payload.message);
        }
      });
      
      // Register status change callback from session manager
      sessionManager.setStatusChangeCallback((sessionId, status, message) => {
        this.notifySessionStatusChange(sessionId, status, message);
      });
    }
  }

  /**
   * Initialize Redis pub/sub integration for real-time metrics
   * Phase 1: Real-time distribution via Redis pub/sub
   */
  async initializeRedis(): Promise<void> {
    // Prevent duplicate initialization
    if (this.redisSubscriber) {
      logger.info('  Redis already initialized, skipping');
      return;
    }
    
    try {
      const { redisClient } = await import('../redis/client');
      const { getRedisSubscriber } = await import('../redis/client-factory');
      
      this.redisClient = redisClient;
      
      // Get dedicated subscriber client from factory
      this.redisSubscriber = getRedisSubscriber();
      
      // Subscribe to patterns for device metrics and logs
      const metricsPattern = 'device:*:metrics';
      const logsPattern = 'device:*:logs';
      await this.redisSubscriber.psubscribe(metricsPattern, logsPattern);
      
      //Handle incoming messages
      this.redisSubscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
        try {
          const data = JSON.parse(message);
          const parts = channel.split(':');
          const uuid = parts[1]; // Extract UUID from "device:uuid:metrics" or "device:uuid:logs"
          const channelType = parts[2]; // "metrics" or "logs"
          
          if (channelType === 'metrics') {
            this.handleRedisMetrics(uuid, data.metrics);
          } else if (channelType === 'logs') {
            this.handleRedisLogs(uuid, data.logs);
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
        logger.info('  Redis subscriber connected and ready');
      });
      
      logger.info('  Redis pub/sub integration initialized');
      logger.info('   Subscribed to patterns:', metricsPattern, logsPattern);
    } catch (error) {
      logger.error('   Failed to initialize Redis pub/sub:', error);
      logger.info('  Falling back to database polling');
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
      logger.info(` Started batch flush interval for device ${deviceUuid.substring(0, 8)}... (every ${this.BATCH_FLUSH_INTERVAL_MS}ms)`);
    }
    
    // Also update processes if present (send immediately, not batched)
    if (metrics.top_processes) {
      this.broadcast(deviceUuid, {
        type: 'processes',
        deviceUuid,
        data: { top_processes: metrics.top_processes },
        timestamp: new Date().toISOString(),
        source: 'redis',
      });
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
    
    logger.info(`  Received ${logs.length} logs from Redis for ${deviceUuid.substring(0, 8)}...`);
    
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
    
    logger.info(`  Flushing ${buffer.length} metrics for device ${deviceUuid.substring(0, 8)}...`);
    
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
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      
      if (url.pathname === '/ws') {
        const deviceUuid = url.searchParams.get('deviceUuid');
        const type = url.searchParams.get('type'); // 'device' or 'global'
        
        // Allow global connections (for MQTT stats) without deviceUuid
        if (!deviceUuid && type !== 'global') {
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }

        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          if (type === 'global') {
            this.handleGlobalConnection(ws);
          } else {
            this.handleConnection(ws, deviceUuid!);
          }
        });
      } else {
        socket.destroy();
      }
    });

    logger.info(' Server initialized');
  }

  private handleConnection(ws: WebSocket, deviceUuid: string): void {
    logger.info(` Client connected for device: ${deviceUuid}`);
    logger.info(` Total clients: ${this.clients.size + 1}`);

    const client: WebSocketClient = {
      ws,
      deviceUuid,
      subscriptions: new Set(),
      intervals: new Map(),
    };

    this.clients.set(ws, client);

    // Track clients per device
    if (!this.deviceClients.has(deviceUuid)) {
      this.deviceClients.set(deviceUuid, new Set());
    }
    this.deviceClients.get(deviceUuid)!.add(ws);

    // Send welcome message
    this.send(ws, {
      type: 'connected',
      deviceUuid,
      message: 'WebSocket connection established',
    });

    ws.on('message', (data) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        logger.info(` Received message from client:`, message);
        this.handleMessage(client, message);
      } catch (error) {
        logger.error(' Failed to parse message:', error);
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

  private handleGlobalConnection(ws: WebSocket): void {
    logger.info(` Global client connected (MQTT stats)`);
    logger.info(` Total clients: ${this.clients.size + 1}`);

    const client: WebSocketClient = {
      ws,
      deviceUuid: null, // Global connection
      subscriptions: new Set(),
      intervals: new Map(),
    };

    this.clients.set(ws, client);
    this.globalClients.add(ws);

    // Send welcome message
    this.send(ws, {
      type: 'connected',
      message: 'Global WebSocket connection established (MQTT stats)',
    });

    ws.on('message', (data) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        logger.info(` Received message from global client:`, message);
        this.handleGlobalMessage(client, message);
      } catch (error) {
        logger.error(' Failed to parse message:', error);
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
    logger.info(` Global client subscribed to ${channel}`);
    
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
    logger.info(` Global client unsubscribed from ${channel}`);
    
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
    logger.info(` Global client disconnected`);

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

    logger.info(` Total clients: ${this.clients.size}`);
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
        this.handleCreateSession(client, message);
        break;

      case 'attach-session':
        this.handleAttachSession(client, message);
        break;

      case 'detach-session':
        this.handleDetachSession(client, message);
        break;

      case 'terminate-session':
        this.handleTerminateSession(client, message);
        break;

      case 'clear-all-sessions':
        this.handleClearAllSessions(client, message);
        break;

      case 'list-sessions':
        this.handleListSessions(client, message);
        break;

      case 'shell-input':
        this.handleShellInput(client, message);
        break;

      case 'resize-session':
        this.handleResizeSession(client, message);
        break;

      case 'shell':
        // Legacy support: Forward shell commands to device via MQTT
        logger.info('🐚 [SHELL] Received legacy shell command from WebSocket', {
          deviceUuid: client.deviceUuid?.substring(0, 8) + '...',
          action: message.data?.action,
          hasData: !!message.data?.data
        });
        if (client.deviceUuid && message.data) {
          this.handleShellCommand(client.deviceUuid, message.data);
        }
        break;

      case 'ping':
        this.send(client.ws, { type: 'pong' });
        break;

      default:
        logger.warn(' Unknown message type:', message.type);
    }
  }

  private handleSubscribe(client: WebSocketClient, channel: string): void {
    logger.info(` Client subscribed to ${channel} for device ${client.deviceUuid}`);
    
    if (channel === 'shell') {
      logger.info('🐚 [SHELL] WebSocket client subscribed to shell channel', {
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

    // Send initial data immediately
    this.sendChannelData(client.deviceUuid, channel);

    // Acknowledge subscription
    this.send(client.ws, {
      type: 'subscribed',
      channel,
      deviceUuid: client.deviceUuid,
    });
  }

  private handleUnsubscribe(client: WebSocketClient, channel: string): void {
    logger.info(` Client unsubscribed from ${channel} for device ${client.deviceUuid}`);
    
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
      logger.info(` 📡 Shell channel active for device ${deviceUuid.substring(0, 8)}... (MQTT-based)`);
      return;
    }

    // For real-time channels (history, processes, network-interfaces, logs), use Redis pub/sub if available
    // Only fall back to polling if Redis unavailable
    const redisChannels = ['history', 'processes', 'network-interfaces', 'logs'];
    if (redisChannels.includes(channel) && this.redisClient) {
      logger.info(` 📡 Using Redis pub/sub for ${channel} (real-time updates for device ${deviceUuid.substring(0, 8)}...)`);
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
      case 'processes':
        intervalTime = 60000; // 60 seconds (fallback)
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
        logger.warn(` Unknown channel: ${channel}`);
        return;
    }

    const interval = setInterval(() => {
      this.sendChannelData(deviceUuid, channel);
    }, intervalTime);

    intervals.set(channel, interval);
    logger.info(` Started ${channel} stream for device ${deviceUuid} (interval: ${intervalTime}ms, mode: ${this.redisClient ? 'redis-fallback' : 'polling'})`);
  }

  private stopDataStream(deviceUuid: string, channel: string): void {
    const intervals = this.deviceIntervals.get(deviceUuid);
    if (intervals?.has(channel)) {
      clearInterval(intervals.get(channel)!);
      intervals.delete(channel);
      logger.info(` Stopped ${channel} stream for device ${deviceUuid}`);

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
        logger.warn(` Unknown global channel: ${channel}`);
        return;
    }

    const interval = setInterval(() => {
      this.sendGlobalChannelData(channel);
    }, intervalTime);

    this.globalIntervals.set(channel, interval);
    logger.info(` Started global ${channel} stream (interval: ${intervalTime}ms)`);
  }

  private stopGlobalDataStream(channel: string): void {
    if (this.globalIntervals.has(channel)) {
      clearInterval(this.globalIntervals.get(channel)!);
      this.globalIntervals.delete(channel);
      logger.info(` Stopped global ${channel} stream`);
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
          logger.warn(` Unknown global channel: ${channel}`);
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
        logger.warn(`Failed to fetch MQTT metrics: ${response.status}`);
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
        logger.warn(`Failed to fetch MQTT topics: ${response.status}`);
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
        case 'processes':
          data = await this.fetchProcesses(deviceUuid);
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
      const device = await DeviceModel.getByUuid(deviceUuid);
      if (!device) return null;

      return {
        os: device.os_version || 'Unknown',
        architecture: 'Unknown', // Not stored in DB yet
        uptime: 0, // Not stored in DB yet
        hostname: device.device_name || 'Unknown',
        ipAddress: device.ip_address || 'Unknown',
        macAddress: device.mac_address || 'Unknown',
      };
    } catch (error) {
      logger.error(' Error fetching system info:', error);
      return null;
    }
  }

  private async fetchProcesses(deviceUuid: string): Promise<any> {
    try {
      const device = await DeviceModel.getByUuid(deviceUuid);
      if (!device) return null;

      return {
        top_processes: device.top_processes || [],
      };
    } catch (error) {
      logger.error(' Error fetching processes:', error);
      return null;
    }
  }

  private async fetchMetricsHistory(deviceUuid: string): Promise<any> {
    try {
      // Fetch last 30 minutes of data (not 30 rows)
      // This ensures we get the correct number of points based on agent reporting interval
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const metrics = await DeviceMetricsModel.getRecentByTime(deviceUuid, thirtyMinutesAgo);

      logger.info(` [fetchMetricsHistory] Device ${deviceUuid.substring(0, 8)}: Fetched ${metrics.length} metrics rows (last 30 min from ${thirtyMinutesAgo})`);

      // Log time range of fetched data
      if (metrics.length > 0) {
        const firstTime = new Date(metrics[0].recorded_at);
        const lastTime = new Date(metrics[metrics.length - 1].recorded_at);
        const spanMinutes = (lastTime.getTime() - firstTime.getTime()) / 60000;
        logger.info(` [fetchMetricsHistory] Time range: ${firstTime.toISOString()} to ${lastTime.toISOString()} (${Math.round(spanMinutes)} minutes)`);
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
      // Use same logic as HTTP endpoint /api/v1/devices/:uuid/network-interfaces
      const device = await DeviceModel.getByUuid(deviceUuid);
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
      const logs = await DeviceLogsModel.get(deviceUuid, {
        serviceName,
        limit: 50,
        offset: 0,
      });

      logger.info(` Fetched ${logs.length} log entries for device ${deviceUuid}${serviceName ? ` service ${serviceName}` : ''}`);

      return { logs };
    } catch (error) {
      logger.error(' Error fetching logs:', error);
      return null;
    }
  }

  private handleDisconnect(client: WebSocketClient): void {
    logger.info(` Client disconnected from device: ${client.deviceUuid}`);

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
      logger.debug(`📭 No WebSocket clients for device ${deviceUuid.substring(0, 8)}`);
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
      logger.info(`🐚 [SHELL] 📡 Broadcast shell output to ${sentCount} client(s)`, {
        deviceUuid: deviceUuid.substring(0, 8) + '...',
        totalClients: deviceClients?.size || 0,
        sentCount,
        outputPreview: message.data?.output?.substring(0, 50)
      });
    }

    if (sentCount > 0) {
      logger.info(` Broadcasted ${channel} to ${sentCount} client(s) for device ${deviceUuid}`);
    }
  }

  private send(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Notify attached clients of session status change
   */
  private notifySessionStatusChange(sessionId: string, status: string, message: string): void {
    const attachedClients = sessionManager.getAttachedClients(sessionId);
    
    logger.info(`🐚 [STATUS] Notifying ${attachedClients.size} clients of session ${sessionId.substring(0, 8)}... status change: ${status}`);

    attachedClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, {
          type: 'session-status',
          sessionId,
          data: {
            status,
            message,
          },
        });
      }
    });
  }

  async shutdown(): Promise<void> {
    logger.info(' Shutting down...');

    // Shutdown session manager
    await sessionManager.shutdown();

    // Flush any pending metrics before shutdown
    this.metricsBuffers.forEach((buffer, deviceUuid) => {
      if (buffer.length > 0) {
        logger.info(` 🚨 Flushing ${buffer.length} pending metrics for ${deviceUuid.substring(0, 8)}... before shutdown`);
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

  /**
   * Handle shell command from WebSocket client - forward to device via MQTT
   */
  private async handleShellCommand(deviceUuid: string, data: any): Promise<void> {
    if (!this.mqttManager) {
      logger.error('🐚 [SHELL] ❌ MQTT Manager not set - cannot send shell command');
      return;
    }

    try {
      const topic = `iot/device/${deviceUuid}/agent/shell`;
      const payload = JSON.stringify(data);
      
      logger.info(`🐚 [SHELL] ➡️ Publishing command to MQTT`, {
        deviceUuid: deviceUuid.substring(0, 8) + '...',
        topic,
        action: data.action,
        sessionId: data.sessionId?.substring(0, 8),
      });
      
      await this.mqttManager.publish(topic, payload, 1);
      
      logger.info('🐚 [SHELL] ✅ Command published to MQTT successfully');
    } catch (error) {
      logger.error('🐚 [SHELL] ❌ Failed to send shell command:', error);
    }
  }

  /**
   * Handle shell output from MQTT - forward to WebSocket clients and buffer in session
   */
  private handleShellOutput(deviceUuid: string, message: any): void {
    // Unwrap the message structure: { format: 'json', data: { output: '...', timestamp: '...', sessionId: '...' } }
    const outputData = message?.data || message;
    const sessionId = outputData?.sessionId;
    const output = outputData?.output;
    
    if (sessionId && output) {
      // Mark PTY as active on first output
      if (!sessionManager.isPtyActive(sessionId)) {
        sessionManager.setPtyActive(sessionId, true);
      }
      
      // Session-based output: buffer and broadcast to session clients with fan-out protection
      sessionManager.appendToBuffer(sessionId, output);
      
      const attachedClients = sessionManager.getAttachedClients(sessionId);
      logger.info(`🐚 [SHELL] 📡 Broadcasting to ${attachedClients.size} attached clients for session ${sessionId.substring(0, 8)}...`);
      
      // Fan-out protection: non-blocking sends, skip slow/closed clients
      let sentCount = 0;
      attachedClients.forEach(ws => {
        // Skip if not open (prevents blocking on slow clients)
        if (ws.readyState === WebSocket.OPEN) {
          try {
            this.send(ws, {
              type: 'shell-output',
              sessionId,
              data: { output },
              timestamp: new Date().toISOString(),
              source: 'mqtt',
            });
            sentCount++;
          } catch (err) {
            logger.warn(`🐚 [SHELL] Failed to send to client, will detach on next error`, err);
          }
        }
      });
      
      logger.debug(`🐚 [SHELL] Sent to ${sentCount}/${attachedClients.size} clients`);
    } else {
      // Legacy non-session output: broadcast to all device clients
      logger.info(`🐚 [SHELL] 📡 Broadcasting legacy output to device ${deviceUuid.substring(0, 8)}... clients`);
      
      this.broadcast(deviceUuid, {
        type: 'shell',
        deviceUuid,
        data: outputData,
        timestamp: new Date().toISOString(),
        source: 'mqtt',
      });
    }
    
    logger.info('🐚 [SHELL] ✅ Broadcast complete');
  }

  /**
   * Create a new shell session
   */
  private async handleCreateSession(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const deviceUuid = message.deviceUuid || client.deviceUuid;
      if (!deviceUuid) {
        this.send(client.ws, {
          type: 'error',
          message: 'Device UUID required to create session',
        });
        return;
      }

      const session = await sessionManager.createSession(deviceUuid, message.data?.userId);
      
      // Send start command to device
      await this.handleShellCommand(deviceUuid, {
        action: 'start',
        sessionId: session.sessionId,
      });
      
      // Mark that start command was sent (transitions status to 'starting')
      await sessionManager.markStartCommandSent(session.sessionId);

      // Mark as expecting PTY (will be set to true when first output arrives)
      logger.info(`🐚 [SESSION] Waiting for agent response for session ${session.sessionId.substring(0, 8)}...`);

      this.send(client.ws, {
        type: 'session-created',
        sessionId: session.sessionId,
        deviceUuid,
        data: session,
      });

      logger.info(`🐚 [SESSION] Created and started session ${session.sessionId.substring(0, 8)}... for device ${deviceUuid.substring(0, 8)}...`);
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to create session:', error);
      this.send(client.ws, {
        type: 'error',
        message: `Failed to create session: ${error.message}`,
      });
    }
  }

  /**
   * Attach client to existing session
   * Security: passes userId for ownership validation
   * Auto-restarts PTY if it died
   */
  private async handleAttachSession(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    logger.info(`🐚 [SESSION] handleAttachSession called`, {
      hasSessionId: !!message.data?.sessionId,
      sessionId: message.data?.sessionId?.substring(0, 8) + '...',
      userId: message.data?.userId,
      deviceUuid: client.deviceUuid?.substring(0, 8) + '...'
    });
    
    try {
      const sessionId = message.data?.sessionId;
      const userId = message.data?.userId; // Get userId from message
      
      if (!sessionId) {
        logger.warn(`🐚 [SESSION] No sessionId provided in attach request`);
        this.send(client.ws, {
          type: 'error',
          message: 'Session ID required',
        });
        return;
      }

      logger.info(`🐚 [SESSION] Calling sessionManager.attachSession for ${sessionId.substring(0, 8)}...`);
      
      // Pass userId for security validation - returns buffer and PTY restart flag
      const result = await sessionManager.attachSession(sessionId, client.ws, userId);

      logger.info(`🐚 [SESSION] attachSession succeeded, buffer size: ${result.buffer.length} chunks, needsPtyRestart: ${result.needsPtyRestart}`);

      // Only send PTY start command if it needs to be restarted
      // For brand new sessions, PTY was already started during creation
      if (client.deviceUuid && result.needsPtyRestart) {
        logger.info(`🐚 [SESSION] Restarting PTY for session ${sessionId.substring(0, 8)}...`);
        
        await this.handleShellCommand(client.deviceUuid, {
          action: 'start',
          sessionId: sessionId,
        });
        
        logger.info(`🐚 [SESSION] PTY start command sent for session ${sessionId.substring(0, 8)}...`);
      } else {
        logger.info(`🐚 [SESSION] PTY already running for session ${sessionId.substring(0, 8)}, skipping start command`);
      }

      this.send(client.ws, {
        type: 'session-attached',
        sessionId,
        data: { 
          buffer: result.buffer,
          ptyRestarted: result.needsPtyRestart, // Inform client that PTY was restarted
        },
      });

      logger.info(`🐚 [SESSION] Client attached to session ${sessionId.substring(0, 8)}...`);
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to attach session:', error);
      logger.error('🐚 [SESSION] Error stack:', error.stack);
      this.send(client.ws, {
        type: 'error',
        message: `Failed to attach session: ${error.message}`,
      });
    }
  }

  /**
   * Detach client from session (session persists)
   */
  private async handleDetachSession(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const sessionId = message.data?.sessionId;
      if (!sessionId) {
        return;
      }

      await sessionManager.detachSession(sessionId, client.ws);

      this.send(client.ws, {
        type: 'session-detached',
        sessionId,
      });

      logger.info(`🐚 [SESSION] Client detached from session ${sessionId.substring(0, 8)}...`);
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to detach session:', error);
    }
  }

  /**
   * Terminate session (kill PTY)
   */
  private async handleTerminateSession(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const sessionId = message.data?.sessionId;
      if (!sessionId) {
        this.send(client.ws, {
          type: 'error',
          message: 'Session ID required',
        });
        return;
      }

      // Get session info before terminating
      const sessions = await sessionManager.listSessions();
      const session = sessions.find(s => s.sessionId === sessionId);
      
      if (session) {
        // Send stop command to device
        await this.handleShellCommand(session.deviceUuid, {
          action: 'stop',
          sessionId,
        });
      }

      await sessionManager.terminateSession(sessionId);

      // Clean up command buffer for this session
      this.commandBuffers.delete(sessionId);

      // Note: session-terminated message is sent by sessionManager.terminateSession()
      // to all attached clients, no need to send again here

      logger.info(`🐚 [SESSION] Terminated session ${sessionId.substring(0, 8)}...`);
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to terminate session:', error);
      this.send(client.ws, {
        type: 'error',
        message: `Failed to terminate session: ${error.message}`,
      });
    }
  }

  /**
   * Clear all sessions for the user
   */
  private async handleClearAllSessions(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const userId = message.data?.userId;
      const deviceUuid = message.deviceUuid || client.deviceUuid;

      logger.info(`🐚 [SESSION] 🗑️ CLEAR ALL SESSIONS - Received request`);
      logger.info(`🐚 [SESSION] 🗑️ Device UUID: ${deviceUuid?.substring(0, 8)}...`);
      logger.info(`🐚 [SESSION] 🗑️ User ID: ${userId || 'none'}`);

      if (!deviceUuid) {
        logger.error(`🐚 [SESSION] 🗑️ ERROR - No device UUID provided`);
        this.send(client.ws, {
          type: 'error',
          message: 'Device UUID required',
        });
        return;
      }

      // Get sessions before clearing
      const sessionsBefore = await sessionManager.listSessions(deviceUuid);
      logger.info(`🐚 [SESSION] 🗑️ Sessions BEFORE clear: ${sessionsBefore.length}`);
      sessionsBefore.forEach(s => {
        logger.info(`🐚 [SESSION] 🗑️   - ${s.sessionId.substring(0, 8)}... status=${s.status} userId=${s.userId || 'none'}`);
      });

      logger.info(`🐚 [SESSION] 🗑️ Calling terminateAllSessions()...`);
      // Terminate all sessions
      await sessionManager.terminateAllSessions(deviceUuid, userId);
      logger.info(`🐚 [SESSION] 🗑️ terminateAllSessions() completed`);

      // Clean up command buffers for all sessions from this device
      sessionsBefore.forEach(session => {
        this.commandBuffers.delete(session.sessionId);
      });
      logger.info(`🐚 [SESSION] 🗑️ Cleared ${sessionsBefore.length} command buffers`);

      // Get sessions after clearing
      const sessionsAfter = await sessionManager.listSessions(deviceUuid);
      logger.info(`🐚 [SESSION] 🗑️ Sessions AFTER clear: ${sessionsAfter.length}`);
      sessionsAfter.forEach(s => {
        logger.info(`🐚 [SESSION] 🗑️   - ${s.sessionId.substring(0, 8)}... status=${s.status} userId=${s.userId || 'none'}`);
      });

      // Send confirmation message
      logger.info(`🐚 [SESSION] 🗑️ Sending all-sessions-cleared confirmation`);
      this.send(client.ws, {
        type: 'all-sessions-cleared',
        message: 'All sessions cleared successfully',
      });

      // Send updated sessions list
      logger.info(`🐚 [SESSION] 🗑️ Sending sessions-list with ${sessionsAfter.length} sessions`);
      this.send(client.ws, {
        type: 'sessions-list',
        data: { sessions: sessionsAfter },
      });

      logger.info(`🐚 [SESSION] 🗑️ CLEAR ALL SESSIONS - Completed successfully`);
    } catch (error: any) {
      logger.error('🐚 [SESSION] 🗑️ CLEAR ALL SESSIONS - Failed:', error);
      this.send(client.ws, {
        type: 'error',
        message: `Failed to clear sessions: ${error.message}`,
      });
    }
  }

  /**
   * List sessions for device
   */
  private async handleListSessions(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const deviceUuid = message.deviceUuid || client.deviceUuid;
      const sessions = await sessionManager.listSessions(deviceUuid);

      this.send(client.ws, {
        type: 'sessions-list',
        deviceUuid,
        data: { sessions },
      });

      logger.info(`🐚 [SESSION] Listed ${sessions.length} sessions for device ${deviceUuid?.substring(0, 8)}...`);
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to list sessions:', error);
      this.send(client.ws, {
        type: 'error',
        message: `Failed to list sessions: ${error.message}`,
      });
    }
  }

  /**
   * Handle shell input for a session
   */
  private async handleShellInput(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const sessionId = message.data?.sessionId;
      const input = message.data?.input ?? message.data?.data;
      
      if (!sessionId || input === undefined) {
        this.send(client.ws, {
          type: 'error',
          message: 'Session ID and input required',
        });
        return;
      }

      // Get session to find device UUID and user ID
      const sessions = await sessionManager.listSessions();
      const session = sessions.find(s => s.sessionId === sessionId);
      
      if (!session) {
        this.send(client.ws, {
          type: 'error',
          message: 'Session not found',
        });
        return;
      }

      // Track command for audit logging (Option B: log on Enter)
      await this.trackShellCommand(sessionId, input, session.deviceUuid, session.userId);

      // Forward input to device
      await this.handleShellCommand(session.deviceUuid, {
        action: 'input',
        sessionId,
        data: input,
      });

      logger.debug(`🐚 [SESSION] Forwarded input to session ${sessionId.substring(0, 8)}...`);
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to handle shell input:', error);
      this.send(client.ws, {
        type: 'error',
        message: `Failed to send input: ${error.message}`,
      });
    }
  }

  /**
   * Handle terminal resize requests
   */
  private async handleResizeSession(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    try {
      const sessionId = message.data?.sessionId;
      const cols = message.data?.cols;
      const rows = message.data?.rows;
      
      if (!sessionId || !cols || !rows) {
        logger.warn('🐚 [SESSION] Invalid resize request - missing sessionId, cols, or rows');
        return;
      }

      // Get session to find device UUID
      const sessions = await sessionManager.listSessions();
      const session = sessions.find(s => s.sessionId === sessionId);
      
      if (!session) {
        logger.warn(`🐚 [SESSION] Cannot resize - session ${sessionId.substring(0, 8)}... not found`);
        return;
      }

      // Forward resize command to device
      await this.handleShellCommand(session.deviceUuid, {
        action: 'resize',
        sessionId,
        cols,
        rows,
      });

      logger.debug(`🐚 [SESSION] Forwarded resize (${cols}x${rows}) to session ${sessionId.substring(0, 8)}...`);
    } catch (error: any) {
      logger.error('🐚 [SESSION] Failed to handle resize:', error);
    }
  }

  private async trackShellCommand(
    sessionId: string,
    input: string,
    deviceUuid: string,
    userId: string
  ): Promise<void> {
    try {
      // Get or initialize command buffer for this session
      let commandBuffer = this.commandBuffers.get(sessionId) || '';

      // Check if this is Enter key (carriage return or newline)
      const isEnter = input === '\r' || input === '\n';

      if (isEnter) {
        // Log the command if buffer is not empty (ignore empty commands)
        if (commandBuffer.trim().length > 0) {
          await query(
            `INSERT INTO shell_audit_log (user_id, device_uuid, session_id, command)
             VALUES ($1, $2, $3, $4)`,
            [userId, deviceUuid, sessionId, commandBuffer]
          );
          
          logger.info('📝 [AUDIT] Logged shell command', {
            sessionId: sessionId.substring(0, 8),
            deviceUuid: deviceUuid.substring(0, 8),
            userId,
            commandLength: commandBuffer.length
          });
        }
        
        // Clear buffer after logging
        this.commandBuffers.delete(sessionId);
      } else if (input === '\x7f' || input === '\b') {
        // Handle backspace/delete - remove last character from buffer
        commandBuffer = commandBuffer.slice(0, -1);
        this.commandBuffers.set(sessionId, commandBuffer);
      } else if (input === '\x03') {
        // Handle Ctrl+C - clear buffer
        this.commandBuffers.delete(sessionId);
      } else {
        // Accumulate regular characters
        commandBuffer += input;
        this.commandBuffers.set(sessionId, commandBuffer);
      }
    } catch (error: any) {
      logger.error('📝 [AUDIT] Failed to track shell command:', error);
      // Don't throw - audit logging failure shouldn't break shell functionality
    }
  }
}

export const websocketManager = new WebSocketManager();
