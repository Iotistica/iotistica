import { buildApiUrl } from '@/config/api';

export interface SystemMetricsData {
  cpu: number;
  memory: number;
  disk: number;
  networkSpeed: number;
  timestamp: string;
}

export interface ProcessData {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
  command?: string;
}

export interface NetworkInterfaceData {
  id: string;
  name: string;
  type: 'wifi' | 'ethernet' | 'mobile';
  ipAddress: string;
  status: 'connected' | 'disconnected';
  speed?: string;
  signal?: number;
  mac?: string;
  default?: boolean;
  virtual?: boolean;
}

export interface SystemInfoData {
  os: string;
  architecture: string;
  uptime: number;
  hostname: string;
  ipAddress: string;
  macAddress: string;
}

export interface MetricsHistoryData {
  cpu: Array<{ time: string; value: number }>;
  memory: Array<{ time: string; used: number; available: number }>;
  network: Array<{ time: string; download: number; upload: number }>;
}

export interface MqttStatsData {
  connected: boolean;
  broker: string;
  uptime: number;
  messageRate: {
    published: number;
    received: number;
    total: number;
  };
  throughput: {
    inbound: number;
    outbound: number;
    total: number;
  };
  clients: number;
  subscriptions: number;
  retainedMessages: number;
  totalMessagesSent: number;
  totalMessagesReceived: number;
  totalTopics: number;
  topicsWithSchemas: number;
  schemasDetected: number;
  messageTypeBreakdown: Record<string, number>;
  systemStats: any;
  timestamp: string;
}

export interface MqttTopicsData {
  topics: any[];
  count: number;
}

type MessageHandler = (data: any) => void;

class WebSocketService {
  private socket: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 3000;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private deviceUuid: string | null = null;
  private isIntentionallyClosed = false;
  private connectionPending = false; // Prevent overlapping connection attempts

  constructor() {
    // Bind methods
    this.connect = this.connect.bind(this);
    this.disconnect = this.disconnect.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.unsubscribe = this.unsubscribe.bind(this);
  }

  connect(deviceUuid: string) {
    // Don't reconnect if we're already connected to this device
    if (this.socket?.readyState === WebSocket.OPEN && this.deviceUuid === deviceUuid) {
      console.log('[WebSocket] Already connected to', deviceUuid);
      return;
    }

    // Don't create duplicate connections if already connecting
    if (this.socket?.readyState === WebSocket.CONNECTING && this.deviceUuid === deviceUuid) {
      console.log('[WebSocket] Already connecting to', deviceUuid);
      return;
    }

    // Prevent overlapping connection attempts from rapid re-renders
    if (this.connectionPending && this.deviceUuid === deviceUuid) {
      console.log('[WebSocket] Connection attempt already pending for', deviceUuid);
      return;
    }

    // Close existing connection if connecting to a different device
    if (this.socket && this.deviceUuid !== deviceUuid) {
      console.log('[WebSocket] Switching device, closing old connection');
      this.disconnect();
    }

    this.deviceUuid = deviceUuid;
    this.isIntentionallyClosed = false;
    this.connectionPending = true;

    const token = localStorage.getItem('accessToken');
    if (!token) {
      console.warn('[WebSocket] Missing access token, cannot connect');
      this.connectionPending = false;
      return;
    }

    const wsUrl = new URL(buildApiUrl(`/ws?deviceUuid=${deviceUuid}`));
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('token', token);
    console.log('[WebSocket] Connecting to:', wsUrl.toString());

    this.createWebSocket(wsUrl.toString(), ['system-info', 'processes', 'history', 'network-interfaces']);
  }

  connectGlobal() {
    // Don't reconnect if already connected to global
    if (this.socket?.readyState === WebSocket.OPEN && this.deviceUuid === 'global') {
      console.log('[WebSocket] Already connected to global');
      return;
    }

    // Don't create duplicate connections if already connecting
    if (this.socket?.readyState === WebSocket.CONNECTING && this.deviceUuid === 'global') {
      console.log('[WebSocket] Already connecting to global');
      return;
    }

    // Prevent overlapping connection attempts
    if (this.connectionPending && this.deviceUuid === 'global') {
      console.log('[WebSocket] Global connection attempt already pending');
      return;
    }

    // Close existing connection if switching from device to global
    if (this.socket && this.deviceUuid !== 'global') {
      console.log('[WebSocket] Switching to global, closing old connection');
      this.disconnect();
    }

    this.deviceUuid = 'global';
    this.isIntentionallyClosed = false;
    this.connectionPending = true;

    const token = localStorage.getItem('accessToken');
    if (!token) {
      console.warn('[WebSocket] Missing access token, cannot connect');
      this.connectionPending = false;
      return;
    }

    const wsUrl = new URL(buildApiUrl('/ws?type=global'));
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('token', token);
    console.log('[WebSocket] Connecting to global:', wsUrl.toString());

    this.createWebSocket(wsUrl.toString(), ['mqtt-stats', 'mqtt-topics']);
  }

  private createWebSocket(wsUrl: string, channels: string[]): void {
    try {
      this.socket = new WebSocket(wsUrl);

      this.socket.onopen = () => {
        const connectionType = this.deviceUuid === 'global' ? 'global' : `device ${this.deviceUuid}`;
        console.log(`[WebSocket] Connected to ${connectionType}`);
        this.reconnectAttempts = 0;
        this.connectionPending = false;
        
        // Subscribe to all channels individually
        channels.forEach(channel => {
          this.send({
            type: 'subscribe',
            channel: channel
          });
        });
      };

      this.socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          const { type, data } = message;

          // Enhanced logging for history messages
          if (type === 'history') {
            console.log('[WebSocket] HISTORY MESSAGE RECEIVED:', {
              type,
              hasData: !!data,
              cpuCount: data?.cpu?.length,
              memoryCount: data?.memory?.length,
              networkCount: data?.network?.length,
              firstCpu: data?.cpu?.[0],
              firstMemory: data?.memory?.[0],
              firstNetwork: data?.network?.[0],
              fullData: data // Show full data for debugging
            });
          } else {
            console.log('[WebSocket] Received message:', { 
              type, 
              hasData: !!data, 
              dataKeys: data ? Object.keys(data) : []
            });
          }

          // Notify all handlers for this message type
          const handlers = this.handlers.get(type);
          if (handlers) {
            console.log(`[WebSocket] Notifying ${handlers.size} handler(s) for type: ${type}`);
            handlers.forEach(handler => {
              try {
                handler(data);
              } catch (err) {
                console.error(`[WebSocket] Handler error for type ${type}:`, err);
              }
            });
          } else {
            console.warn(`[WebSocket] No handlers registered for message type: ${type}`);
          }
        } catch (error) {
          console.error('[WebSocket] Error parsing message:', error);
        }
      };

      this.socket.onerror = () => {
        console.warn('[WebSocket] Connection error (this is normal if device is offline or API is unavailable)');
        this.connectionPending = false;
        // Don't log the error object as it doesn't contain useful info
      };

      this.socket.onclose = (event) => {
        const connectionType = this.deviceUuid === 'global' ? 'global' : `device ${this.deviceUuid?.substring(0, 8)}`;
        console.log(`[WebSocket] Connection closed for ${connectionType}:`, {
          code: event.code,
          reason: event.reason || 'No reason provided',
          wasClean: event.wasClean
        });
        this.socket = null;
        this.connectionPending = false;

        // Only attempt reconnect if not intentionally closed and within retry limit
        if (!this.isIntentionallyClosed && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          
          // Special handling for connection refused (device likely offline)
          if (event.code === 1006) {
            console.log(`[WebSocket] Device appears offline, will retry ${this.maxReconnectAttempts - this.reconnectAttempts} more time(s)`);
          } else {
            console.log(`[WebSocket] Reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
          }
          
          this.reconnectTimeout = setTimeout(() => {
            if (this.deviceUuid === 'global') {
              this.connectGlobal();
            } else if (this.deviceUuid) {
              this.connect(this.deviceUuid);
            }
          }, this.reconnectDelay);
        }
      };
    } catch (error) {
      console.error('[WebSocket] Failed to create connection:', error);
      this.connectionPending = false;
    }
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.socket) {
      console.log('[WebSocket] Disconnecting...');
      this.socket.close();
      this.socket = null;
    }

    this.deviceUuid = null;
    this.reconnectAttempts = 0;
  }

  subscribe(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    console.log(`[WebSocket] Subscribed to type: ${type}, total handlers: ${this.handlers.get(type)!.size}`);

    // Return unsubscribe function
    return () => this.unsubscribe(type, handler);
  }

  unsubscribe(type: string, handler: MessageHandler) {
    const handlers = this.handlers.get(type);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(type);
      }
    }
  }

  send(message: any) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else {
      console.warn('[WebSocket] Cannot send message, socket not open');
    }
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}

// Export singleton instance
export const websocketService = new WebSocketService();
