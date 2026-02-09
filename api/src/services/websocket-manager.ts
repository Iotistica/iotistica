import { WebSocketServer, WebSocket } from 'ws';
import { Server as HTTPServer } from 'http';
import { DeviceModel, DeviceMetricsModel, DeviceLogsModel } from '../db/models';
import logger from '../utils/logger';
import fetch from 'node-fetch';

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

  setMqttMonitor(monitor: any): void {
    this.mqttMonitor = monitor;
    logger.info(' MQTT Monitor instance set');
  }

  setMqttManager(manager: any): void {
    this.mqttManager = manager;
    logger.info(' MQTT Manager instance set for shell commands');
    
    // Subscribe to shell-output topic for all devices
    if (manager) {
      manager.subscribeTopic('iot/device/+/agent/shell-output', 1).then(() => {
        logger.info(' Subscribed to shell-output topic');
      }).catch((err: any) => {
        logger.error(' Failed to subscribe to shell-output topic:', err);
      });
      
      // Handle shell output messages
      manager.on('agent', (payload: any) => {
        if (payload.subTopic === 'shell-output') {
          this.handleShellOutput(payload.deviceUuid, payload.message);
        }
      });
    }
  }

  /**
   * Initialize Redis pub/sub integration for real-time metrics
   * Phase 1: Real-time distribution via Redis pub/sub
   */
  async initializeRedis(): Promise<void> {
    try {
      const { redisClient } =await import('../redis/client');
      this.redisClient = redisClient;
      
      // Import ioredis to create subscriber client
      const Redis = (await import('ioredis')).default;
      
      const host = process.env.REDIS_HOST || 'localhost';
      const port = parseInt(process.env.REDIS_PORT || '6379', 10);
      
      // Create dedicated subscriber client (required by ioredis for pub/sub)
      this.redisSubscriber = new Redis({
        host,
        port,
        retryStrategy: (times: number) => {
          if (times > 5) {
            logger.error(' Redis subscriber max retries reached');
            return null;
          }
          return Math.min(times * 1000, 3000);
        },
      });
      
      // Subscribe to patterns for device metrics and logs
      const metricsPattern = 'device:*:metrics';
      const logsPattern = 'device:*:logs';
      await this.redisSubscriber.psubscribe(metricsPattern, logsPattern);
      
      // Handle incoming messages
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

      case 'shell':
        // Forward shell commands to device via MQTT
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

    if (sentCount > 0) {
      logger.info(` Broadcasted ${channel} to ${sentCount} client(s) for device ${deviceUuid}`);
    }
  }

  private send(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  shutdown(): void {
    logger.info(' Shutting down...');

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
      logger.error(' MQTT Manager not set - cannot send shell command');
      return;
    }

    try {
      const topic = `iot/device/${deviceUuid}/agent/shell`;
      const payload = JSON.stringify(data);
      
      logger.info(` Sending shell command to device ${deviceUuid.substring(0, 8)}...`, { action: data.action });
      await this.mqttManager.publish(topic, payload, 1);
    } catch (error) {
      logger.error(' Failed to send shell command:', error);
    }
  }

  /**
   * Handle shell output from MQTT - forward to WebSocket clients
   */
  private handleShellOutput(deviceUuid: string, message: any): void {
    logger.debug(` Received shell output from device ${deviceUuid.substring(0, 8)}...`);
    
    this.broadcast(deviceUuid, {
      type: 'shell',
      deviceUuid,
      data: message,
      timestamp: new Date().toISOString(),
      source: 'mqtt',
    });
  }
}

export const websocketManager = new WebSocketManager();
