/**
 * Prometheus Exporter for MQTT Monitor
 * Exposes MQTT broker metrics and topic statistics in Prometheus format
 */

import { Registry, Gauge, Counter, Histogram } from 'prom-client';
import type { CalculatedMetrics, BrokerStats } from './monitor';

export class PrometheusExporter {
  private registry: Registry;
  
  // Connection metrics
  private mqttConnected: Gauge;
  
  // Broker metrics
  private brokerClientsConnected: Gauge;
  private brokerSubscriptions: Gauge;
  private brokerRetainedMessages: Gauge;
  private brokerMessagesSent: Gauge;
  private brokerMessagesReceived: Gauge;
  private brokerBytesSent: Gauge;
  private brokerBytesReceived: Gauge;
  
  // Rate metrics
  private brokerMessageRatePublished: Gauge;
  private brokerMessageRateReceived: Gauge;
  private brokerThroughputInbound: Gauge;
  private brokerThroughputOutbound: Gauge;
  
  // Topic tree metrics
  private topicCount: Gauge;
  private messageCount: Gauge;
  
  // Monitoring service metrics
  private samplingRate: Counter;
  private degradedModeActive: Gauge;
  private droppedPayloadsTotal: Counter;
  
  // Topic-level metrics (with labels)
  private topicMessagesTotal: Counter;
  private topicBytesTotal: Counter;
  private topicSchemaVersion: Gauge;
  private topicSchemaConfidence: Gauge;
  
  // Performance metrics
  private metricsUpdateDuration: Histogram;
  
  constructor() {
    this.registry = new Registry();
    
    // Connection status
    this.mqttConnected = new Gauge({
      name: 'mqtt_monitor_connected',
      help: 'MQTT broker connection status (1 = connected, 0 = disconnected)',
      registers: [this.registry]
    });
    
    // Broker metrics
    this.brokerClientsConnected = new Gauge({
      name: 'mqtt_broker_clients_connected',
      help: 'Currently connected clients',
      registers: [this.registry]
    });
    
    this.brokerSubscriptions = new Gauge({
      name: 'mqtt_broker_subscriptions',
      help: 'Active subscriptions',
      registers: [this.registry]
    });
    
    this.brokerRetainedMessages = new Gauge({
      name: 'mqtt_broker_retained_messages',
      help: 'Retained messages count',
      registers: [this.registry]
    });
    
    this.brokerMessagesSent = new Gauge({
      name: 'mqtt_broker_messages_sent_total',
      help: 'Total messages sent by broker',
      registers: [this.registry]
    });
    
    this.brokerMessagesReceived = new Gauge({
      name: 'mqtt_broker_messages_received_total',
      help: 'Total messages received by broker',
      registers: [this.registry]
    });
    
    this.brokerBytesSent = new Gauge({
      name: 'mqtt_broker_bytes_sent_total',
      help: 'Total bytes sent by broker',
      registers: [this.registry]
    });
    
    this.brokerBytesReceived = new Gauge({
      name: 'mqtt_broker_bytes_received_total',
      help: 'Total bytes received by broker',
      registers: [this.registry]
    });
    
    // Rate metrics
    this.brokerMessageRatePublished = new Gauge({
      name: 'mqtt_broker_message_rate_published',
      help: 'Current message rate published (messages/second)',
      registers: [this.registry]
    });
    
    this.brokerMessageRateReceived = new Gauge({
      name: 'mqtt_broker_message_rate_received',
      help: 'Current message rate received (messages/second)',
      registers: [this.registry]
    });
    
    this.brokerThroughputInbound = new Gauge({
      name: 'mqtt_broker_throughput_inbound_kbps',
      help: 'Current inbound throughput (KB/sec)',
      registers: [this.registry]
    });
    
    this.brokerThroughputOutbound = new Gauge({
      name: 'mqtt_broker_throughput_outbound_kbps',
      help: 'Current outbound throughput (KB/sec)',
      registers: [this.registry]
    });
    
    // Topic tree metrics
    this.topicCount = new Gauge({
      name: 'mqtt_monitor_topics_total',
      help: 'Total number of topics being monitored',
      registers: [this.registry]
    });
    
    this.messageCount = new Gauge({
      name: 'mqtt_monitor_messages_total',
      help: 'Total number of messages processed',
      registers: [this.registry]
    });
    
    // Monitoring service metrics
    this.samplingRate = new Counter({
      name: 'mqtt_monitor_sampled_messages_total',
      help: 'Total number of sampled messages (rate-limited)',
      labelNames: ['reason'],
      registers: [this.registry]
    });
    
    this.degradedModeActive = new Gauge({
      name: 'mqtt_monitor_degraded_mode',
      help: 'Degraded mode status (1 = active, 0 = normal)',
      registers: [this.registry]
    });
    
    this.droppedPayloadsTotal = new Counter({
      name: 'mqtt_monitor_dropped_payloads_total',
      help: 'Total number of dropped payloads due to backpressure',
      registers: [this.registry]
    });
    
    // Topic-level metrics
    this.topicMessagesTotal = new Counter({
      name: 'mqtt_topic_messages_total',
      help: 'Total messages per topic',
      labelNames: ['topic', 'message_type'],
      registers: [this.registry]
    });
    
    this.topicBytesTotal = new Counter({
      name: 'mqtt_topic_bytes_total',
      help: 'Total bytes per topic',
      labelNames: ['topic'],
      registers: [this.registry]
    });
    
    this.topicSchemaVersion = new Gauge({
      name: 'mqtt_topic_schema_version',
      help: 'Schema version for JSON topics',
      labelNames: ['topic'],
      registers: [this.registry]
    });
    
    this.topicSchemaConfidence = new Gauge({
      name: 'mqtt_topic_schema_confidence',
      help: 'Schema confidence (0-1) based on stability',
      labelNames: ['topic'],
      registers: [this.registry]
    });
    
    // Performance metrics
    this.metricsUpdateDuration = new Histogram({
      name: 'mqtt_monitor_metrics_update_duration_seconds',
      help: 'Duration of metrics update operations',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.registry]
    });
  }
  
  /**
   * Update connection status
   */
  updateConnectionStatus(connected: boolean): void {
    this.mqttConnected.set(connected ? 1 : 0);
  }
  
  /**
   * Update broker metrics from calculated metrics
   */
  updateBrokerMetrics(metrics: CalculatedMetrics): void {
    const endTimer = this.metricsUpdateDuration.startTimer();
    
    try {
      this.brokerClientsConnected.set(metrics.clients);
      this.brokerSubscriptions.set(metrics.subscriptions);
      this.brokerRetainedMessages.set(metrics.retainedMessages);
      this.brokerMessagesSent.set(metrics.totalMessagesSent);
      this.brokerMessagesReceived.set(metrics.totalMessagesReceived);
      this.brokerBytesSent.set(metrics.totalBytesSent);
      this.brokerBytesReceived.set(metrics.totalBytesReceived);
      
      // Rate metrics
      this.brokerMessageRatePublished.set(metrics.messageRate.current.published);
      this.brokerMessageRateReceived.set(metrics.messageRate.current.received);
      this.brokerThroughputInbound.set(metrics.throughput.current.inbound);
      this.brokerThroughputOutbound.set(metrics.throughput.current.outbound);
    } finally {
      endTimer();
    }
  }
  
  /**
   * Update topic tree metrics
   */
  updateTopicTreeMetrics(topicCount: number, messageCount: number): void {
    this.topicCount.set(topicCount);
    this.messageCount.set(messageCount);
  }
  
  /**
   * Record sampled message
   */
  recordSampledMessage(reason: 'rate_limit' | 'degraded_mode'): void {
    this.samplingRate.inc({ reason });
  }
  
  /**
   * Update degraded mode status
   */
  updateDegradedMode(active: boolean): void {
    this.degradedModeActive.set(active ? 1 : 0);
  }
  
  /**
   * Record dropped payload
   */
  recordDroppedPayload(): void {
    this.droppedPayloadsTotal.inc();
  }
  
  /**
   * Update topic-level metrics
   */
  updateTopicMetrics(topics: Array<{
    topic: string;
    messageCount: number;
    messageType?: string;
    lastMessage?: string;
    schemaVersion?: number;
    schemaConfidence?: number;
  }>): void {
    // Clear existing topic metrics to avoid stale data
    this.topicMessagesTotal.reset();
    this.topicBytesTotal.reset();
    this.topicSchemaVersion.reset();
    this.topicSchemaConfidence.reset();
    
    for (const topicData of topics) {
      // Message count
      if (topicData.messageCount > 0) {
        this.topicMessagesTotal.inc({
          topic: topicData.topic,
          message_type: topicData.messageType || 'unknown'
        }, topicData.messageCount);
      }
      
      // Byte count (estimate)
      if (topicData.lastMessage) {
        const byteCount = Buffer.byteLength(topicData.lastMessage);
        this.topicBytesTotal.inc({
          topic: topicData.topic
        }, byteCount * topicData.messageCount);
      }
      
      // Schema metrics (JSON topics only)
      if (topicData.schemaVersion) {
        this.topicSchemaVersion.set({
          topic: topicData.topic
        }, topicData.schemaVersion);
      }
      
      if (topicData.schemaConfidence !== undefined) {
        this.topicSchemaConfidence.set({
          topic: topicData.topic
        }, topicData.schemaConfidence);
      }
    }
  }
  
  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
  
  /**
   * Get registry content type
   */
  getContentType(): string {
    return this.registry.contentType;
  }
}
