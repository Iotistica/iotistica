/**
 * Minimal Prometheus renderer for MQTT Monitor.
 * Keeps a small in-memory snapshot and renders Prometheus text directly.
 */

import type { CalculatedMetrics } from './monitor';

type SampleReason = 'rate_limit' | 'degraded_mode';

interface MetricDefinition {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
}

interface PrometheusSnapshot {
  connected: number;
  clients: number;
  subscriptions: number;
  topics: number;
  messages: number;
  totalMessagesSent: number;
  totalMessagesReceived: number;
  publishedRate: number;
  receivedRate: number;
  inboundThroughput: number;
  outboundThroughput: number;
  degradedMode: number;
  sampledByReason: Record<SampleReason, number>;
}

const CONTENT_TYPE = 'text/plain; version=0.0.4';

const METRICS: MetricDefinition[] = [
  {
    name: 'mqtt_monitor_connected',
    help: 'MQTT broker connection status (1 = connected, 0 = disconnected)',
    type: 'gauge'
  },
  {
    name: 'mqtt_broker_clients_connected',
    help: 'Currently connected clients',
    type: 'gauge'
  },
  {
    name: 'mqtt_broker_subscriptions',
    help: 'Active subscriptions',
    type: 'gauge'
  },
  {
    name: 'mqtt_monitor_topics_total',
    help: 'Total number of topics being monitored',
    type: 'gauge'
  },
  {
    name: 'mqtt_monitor_messages_total',
    help: 'Total number of messages processed',
    type: 'gauge'
  },
  {
    name: 'mqtt_broker_messages_sent_total',
    help: 'Total messages sent by broker',
    type: 'gauge'
  },
  {
    name: 'mqtt_broker_messages_received_total',
    help: 'Total messages received by broker',
    type: 'gauge'
  },
  {
    name: 'mqtt_broker_message_rate_published',
    help: 'Current message rate published (messages/second)',
    type: 'gauge'
  },
  {
    name: 'mqtt_broker_message_rate_received',
    help: 'Current message rate received (messages/second)',
    type: 'gauge'
  },
  {
    name: 'mqtt_broker_throughput_inbound_kbps',
    help: 'Current inbound throughput (KB/sec)',
    type: 'gauge'
  },
  {
    name: 'mqtt_broker_throughput_outbound_kbps',
    help: 'Current outbound throughput (KB/sec)',
    type: 'gauge'
  },
  {
    name: 'mqtt_monitor_degraded_mode',
    help: 'Degraded mode status (1 = active, 0 = normal)',
    type: 'gauge'
  },
  {
    name: 'mqtt_monitor_sampled_messages_total',
    help: 'Total number of sampled messages',
    type: 'counter'
  }
];

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function formatMetric(name: string, value: number, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) {
    return `${name} ${value}`;
  }

  const renderedLabels = Object.entries(labels)
    .map(([key, labelValue]) => `${key}="${escapeLabelValue(labelValue)}"`)
    .join(',');

  return `${name}{${renderedLabels}} ${value}`;
}

export class PrometheusExporter {
  private snapshot: PrometheusSnapshot = {
    connected: 0,
    clients: 0,
    subscriptions: 0,
    topics: 0,
    messages: 0,
    totalMessagesSent: 0,
    totalMessagesReceived: 0,
    publishedRate: 0,
    receivedRate: 0,
    inboundThroughput: 0,
    outboundThroughput: 0,
    degradedMode: 0,
    sampledByReason: {
      rate_limit: 0,
      degraded_mode: 0
    }
  };

  updateConnectionStatus(connected: boolean): void {
    this.snapshot.connected = connected ? 1 : 0;
  }

  updateBrokerMetrics(metrics: CalculatedMetrics): void {
    this.snapshot.clients = metrics.clients;
    this.snapshot.subscriptions = metrics.subscriptions;
    this.snapshot.totalMessagesSent = metrics.totalMessagesSent;
    this.snapshot.totalMessagesReceived = metrics.totalMessagesReceived;
    this.snapshot.publishedRate = metrics.messageRate.current.published;
    this.snapshot.receivedRate = metrics.messageRate.current.received;
    this.snapshot.inboundThroughput = metrics.throughput.current.inbound;
    this.snapshot.outboundThroughput = metrics.throughput.current.outbound;
  }

  updateTopicTreeMetrics(topicCount: number, messageCount: number): void {
    this.snapshot.topics = topicCount;
    this.snapshot.messages = messageCount;
  }

  recordSampledMessage(reason: SampleReason): void {
    this.snapshot.sampledByReason[reason] += 1;
  }

  updateDegradedMode(active: boolean): void {
    this.snapshot.degradedMode = active ? 1 : 0;
  }

  async getMetrics(): Promise<string> {
    const lines: string[] = [];

    for (const metric of METRICS) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      switch (metric.name) {
        case 'mqtt_monitor_connected':
          lines.push(formatMetric(metric.name, this.snapshot.connected));
          break;
        case 'mqtt_broker_clients_connected':
          lines.push(formatMetric(metric.name, this.snapshot.clients));
          break;
        case 'mqtt_broker_subscriptions':
          lines.push(formatMetric(metric.name, this.snapshot.subscriptions));
          break;
        case 'mqtt_monitor_topics_total':
          lines.push(formatMetric(metric.name, this.snapshot.topics));
          break;
        case 'mqtt_monitor_messages_total':
          lines.push(formatMetric(metric.name, this.snapshot.messages));
          break;
        case 'mqtt_broker_messages_sent_total':
          lines.push(formatMetric(metric.name, this.snapshot.totalMessagesSent));
          break;
        case 'mqtt_broker_messages_received_total':
          lines.push(formatMetric(metric.name, this.snapshot.totalMessagesReceived));
          break;
        case 'mqtt_broker_message_rate_published':
          lines.push(formatMetric(metric.name, this.snapshot.publishedRate));
          break;
        case 'mqtt_broker_message_rate_received':
          lines.push(formatMetric(metric.name, this.snapshot.receivedRate));
          break;
        case 'mqtt_broker_throughput_inbound_kbps':
          lines.push(formatMetric(metric.name, this.snapshot.inboundThroughput));
          break;
        case 'mqtt_broker_throughput_outbound_kbps':
          lines.push(formatMetric(metric.name, this.snapshot.outboundThroughput));
          break;
        case 'mqtt_monitor_degraded_mode':
          lines.push(formatMetric(metric.name, this.snapshot.degradedMode));
          break;
        case 'mqtt_monitor_sampled_messages_total':
          lines.push(formatMetric(metric.name, this.snapshot.sampledByReason.rate_limit, { reason: 'rate_limit' }));
          lines.push(formatMetric(metric.name, this.snapshot.sampledByReason.degraded_mode, { reason: 'degraded_mode' }));
          break;
        default:
          break;
      }

      lines.push('');
    }

    return `${lines.join('\n').trim()}\n`;
  }

  getContentType(): string {
    return CONTENT_TYPE;
  }
}
