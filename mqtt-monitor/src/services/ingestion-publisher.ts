import Redis from 'ioredis';
import logger from '../utils/logger';

interface DeviceDataEntry {
  deviceUuid: string;
  deviceName: string;
  timestamp: string;
  data: Record<string, number>;
  metadata?: Record<string, unknown>;
}

interface BrokerSnapshot {
  clients: number;
  subscriptions: number;
  retainedMessages: number;
  messageRatePublished: number;
  messageRateReceived: number;
  throughputInboundKBs: number;
  throughputOutboundKBs: number;
  totalMessagesSent: number;
  totalMessagesReceived: number;
}

interface TopicMetric {
  topic: string;
  messageRate: number;
  messageCount: number;
  avgMessageSize: number;
  bytesReceived: number;
}

const MONITOR_DEVICE_UUID = process.env.MQTT_MONITOR_DEVICE_UUID || '00000000-0000-0000-0000-000000000000';
const MONITOR_DEVICE_NAME = 'mqtt-broker';

export class IngestionPublisher {
  private redis: Redis | null = null;
  private readonly streamKey: string;
  private readonly maxStreamLength: number;
  private readonly enabled: boolean;
  private connected = false;

  constructor() {
    this.enabled = !/^(0|false|no)$/i.test(process.env.INGESTION_PUBLISH_ENABLED ?? 'true');
    this.streamKey = process.env.REDIS_INGESTION_STREAM_KEY || '';
    this.maxStreamLength = parseInt(process.env.REDIS_INGESTION_STREAM_MAXLEN || '10000', 10);
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      logger.info('Ingestion publishing disabled');
      return;
    }

    if (!this.streamKey) {
      logger.warn('REDIS_INGESTION_STREAM_KEY not set, ingestion publishing disabled');
      return;
    }

    const host = process.env.REDIS_HOST || 'redis';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const password = process.env.REDIS_PASSWORD || undefined;

    try {
      this.redis = new Redis({
        host,
        port,
        password,
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          if (times > 10) return null;
          return Math.min(times * 500, 5000);
        },
        lazyConnect: true,
      });

      this.redis.on('connect', () => {
        this.connected = true;
        logger.debug('Ingestion publisher Redis connected');
      });
      this.redis.on('error', (err) => {
        this.connected = false;
        logger.debug('Ingestion publisher Redis error', { error: err.message });
      });
      this.redis.on('close', () => {
        this.connected = false;
      });

      await this.redis.connect();
      logger.info('Ingestion publisher initialized', { streamKey: this.streamKey });
    } catch (err: any) {
      logger.warn('Ingestion publisher failed to connect to Redis', { error: err.message });
      this.redis = null;
    }
  }

  async publishBrokerMetrics(snapshot: BrokerSnapshot): Promise<void> {
    if (!this.isReady()) return;

    const entry: DeviceDataEntry = {
      deviceUuid: MONITOR_DEVICE_UUID,
      deviceName: MONITOR_DEVICE_NAME,
      timestamp: new Date().toISOString(),
      data: {
        'broker.clients.connected': snapshot.clients,
        'broker.subscriptions': snapshot.subscriptions,
        'broker.retained_messages': snapshot.retainedMessages,
        'broker.messages.published_rate': snapshot.messageRatePublished,
        'broker.messages.received_rate': snapshot.messageRateReceived,
        'broker.throughput.inbound_kbs': snapshot.throughputInboundKBs,
        'broker.throughput.outbound_kbs': snapshot.throughputOutboundKBs,
        'broker.messages.sent_total': snapshot.totalMessagesSent,
        'broker.messages.received_total': snapshot.totalMessagesReceived,
      },
      metadata: { source: 'mqtt-monitor' },
    };

    await this.xadd([entry], 'broker');
  }

  async publishTopicMetrics(topicMetrics: TopicMetric[]): Promise<void> {
    if (!this.isReady() || topicMetrics.length === 0) return;

    const entries: DeviceDataEntry[] = topicMetrics.map((tm) => ({
      deviceUuid: MONITOR_DEVICE_UUID,
      deviceName: MONITOR_DEVICE_NAME,
      timestamp: new Date().toISOString(),
      data: {
        [`topic.message_rate`]: tm.messageRate,
        [`topic.message_count`]: tm.messageCount,
        [`topic.avg_message_size`]: tm.avgMessageSize,
        [`topic.bytes_received`]: tm.bytesReceived,
      },
      metadata: { source: 'mqtt-monitor', topic: tm.topic },
    }));

    await this.xadd(entries, 'broker');
  }

  private async xadd(entries: DeviceDataEntry[], source: string): Promise<void> {
    try {
      await this.redis!.xadd(
        this.streamKey,
        'MAXLEN',
        '~',
        this.maxStreamLength,
        '*',
        'data',
        JSON.stringify(entries),
        'source',
        source,
      );
      logger.debug('Published broker metrics to ingestion stream', { count: entries.length });
    } catch (err: any) {
      logger.warn('Failed to publish broker metrics to ingestion stream', { error: err.message });
    }
  }

  private isReady(): boolean {
    return this.enabled && this.connected && this.redis !== null && this.streamKey !== '';
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => {});
      this.redis = null;
      this.connected = false;
    }
  }
}
