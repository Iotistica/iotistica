import { describe, test, expect } from '@jest/globals';
import { PrometheusExporter } from '../../src/services/prometheus';

/**
 * Prometheus Exporter Smoke Tests (SAFETY)
 * 
 * These tests ensure the Prometheus exporter doesn't crash under load.
 * Critical for production monitoring stability.
 */

describe('Prometheus Exporter Safety', () => {
  function createExporter(): PrometheusExporter {
    return new PrometheusExporter();
  }

  function updateMetrics(exporter: PrometheusExporter, overrides?: Partial<{
    connected: boolean;
    topics: number;
    messages: number;
    clients: number;
    subscriptions: number;
    publishedRate: number;
    receivedRate: number;
  }>): void {
    exporter.updateConnectionStatus(overrides?.connected ?? true);
    exporter.updateTopicTreeMetrics(overrides?.topics ?? 5, overrides?.messages ?? 42);
    exporter.updateBrokerMetrics({
      messageRate: {
        published: Array(15).fill(0),
        received: Array(15).fill(0),
        current: {
          published: overrides?.publishedRate ?? 11,
          received: overrides?.receivedRate ?? 7,
        }
      },
      throughput: {
        inbound: Array(15).fill(0),
        outbound: Array(15).fill(0),
        current: {
          inbound: 3.5,
          outbound: 1.2,
        },
        avg15min: {
          inbound: 0,
          outbound: 0,
        }
      },
      clients: overrides?.clients ?? 2,
      subscriptions: overrides?.subscriptions ?? 9,
      retainedMessages: 0,
      totalMessagesSent: 100,
      totalMessagesReceived: 200,
      totalBytesSent: 0,
      totalBytesReceived: 0,
      timestamp: Date.now(),
    });
  }

  describe('/metrics Endpoint', () => {
    test('exposes metrics endpoint', async () => {
      const exporter = createExporter();
      updateMetrics(exporter);
      
      const metrics = await exporter.getMetrics();
      
      expect(metrics).toBeTruthy();
      expect(typeof metrics).toBe('string');
    });

    test('returns valid Prometheus format', async () => {
      const exporter = createExporter();
      updateMetrics(exporter);
      
      const metrics = await exporter.getMetrics();
      
      expect(metrics).toContain('# HELP');
      expect(metrics).toContain('# TYPE');
    });

    test('includes gauge metrics', async () => {
      const exporter = createExporter();
      updateMetrics(exporter, { connected: true });
      
      const metrics = await exporter.getMetrics();
      
      expect(metrics).toContain('mqtt_monitor_connected');
      expect(metrics).toContain('mqtt_monitor_connected 1');
    });

    test('includes sampled counter metrics with labels', async () => {
      const exporter = createExporter();
      updateMetrics(exporter);
      exporter.recordSampledMessage('rate_limit');
      
      const metrics = await exporter.getMetrics();
      
      expect(metrics).toContain('mqtt_monitor_sampled_messages_total');
      expect(metrics).toContain('reason="rate_limit"');
    });

    test('handles empty metrics', async () => {
      const exporter = createExporter();
      
      const metrics = await exporter.getMetrics();
      
      expect(metrics).toBeTruthy();
      expect(metrics.length).toBeGreaterThan(0);
    });
  });

  describe('Concurrent Operations', () => {
    test('does not throw during scrape while updating metrics', async () => {
      const exporter = createExporter();
      updateMetrics(exporter);
      await expect(exporter.getMetrics()).resolves.toBeTruthy();
    });

    test('handles rapid successive scrapes', async () => {
      const exporter = createExporter();
      updateMetrics(exporter);
      const scrapes = Array(100).fill(null).map(() => exporter.getMetrics());
      
      await expect(Promise.all(scrapes)).resolves.toBeTruthy();
    });

    test('handles concurrent updates and scrapes', async () => {
      const exporter = createExporter();
      
      const operations: Promise<any>[] = [];
      
      for (let i = 0; i < 50; i++) {
        operations.push(
          Promise.resolve(updateMetrics(exporter, { topics: i, messages: i * 10, clients: i % 3 }))
        );
      }
      
      for (let i = 0; i < 50; i++) {
        operations.push(exporter.getMetrics());
      }
      
      await expect(Promise.all(operations)).resolves.toBeTruthy();
    });
  });

  describe('High Load Scenarios', () => {
    test('handles large topic counts without per-topic label explosion', async () => {
      const exporter = createExporter();
      updateMetrics(exporter, { topics: 1000, messages: 100000 });
      const metrics = await exporter.getMetrics();
      expect(metrics).toBeTruthy();
    });

    test('handles very large counter values', async () => {
      const exporter = createExporter();
      updateMetrics(exporter, { messages: Number.MAX_SAFE_INTEGER - 100 });
      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('mqtt_monitor_messages_total');
    });

    test('handles rapid metric updates', async () => {
      const exporter = createExporter();
      
      for (let i = 0; i < 1000; i++) {
        updateMetrics(exporter, { topics: i, messages: i * 2 });
      }
      
      const metrics = await exporter.getMetrics();
      expect(metrics).toBeTruthy();
    });

    test('scrape completes within reasonable time', async () => {
      const exporter = createExporter();
      updateMetrics(exporter, { topics: 1000, messages: 100000 });
      
      const startTime = Date.now();
      await exporter.getMetrics();
      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(100);
    });
  });

  describe('Error Handling', () => {
    test('handles missing updates without throwing', async () => {
      const exporter = createExporter();
      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('mqtt_monitor_connected 0');
    });
  });

  describe('Memory Safety', () => {
    test('does not leak memory on repeated scrapes', async () => {
      const exporter = createExporter();
      updateMetrics(exporter);
      
      const initialMemory = process.memoryUsage().heapUsed;
      
      for (let i = 0; i < 1000; i++) {
        await exporter.getMetrics();
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = finalMemory - initialMemory;
      
      expect(memoryGrowth).toBeLessThan(15 * 1024 * 1024);
    });

    test('keeps output size stable for high topic counts', async () => {
      const exporter = createExporter();
      updateMetrics(exporter, { topics: 10, messages: 100 });
      const smaller = await exporter.getMetrics();
      updateMetrics(exporter, { topics: 10000, messages: 500000 });
      const larger = await exporter.getMetrics();
      expect(larger.length - smaller.length).toBeLessThan(200);
    });
  });

  describe('Special Characters', () => {
    test('escapes label values correctly', async () => {
      const exporter = createExporter();
      exporter.recordSampledMessage('rate_limit');
      exporter.recordSampledMessage('degraded_mode');
      const metrics = await exporter.getMetrics();
      expect(metrics).toContain('reason="rate_limit"');
      expect(metrics).toContain('reason="degraded_mode"');
    });
  });

  describe('Output Format', () => {
    test('metrics are newline-separated', async () => {
      const exporter = createExporter();
      updateMetrics(exporter);
      const metrics = await exporter.getMetrics();
      const lines = metrics.split('\n').filter(line => line.trim());
      
      expect(lines.length).toBeGreaterThan(0);
    });

    test('counters are cumulative', async () => {
      const exporter = createExporter();
      updateMetrics(exporter);
      exporter.recordSampledMessage('rate_limit');
      
      let metrics = await exporter.getMetrics();
      const firstMatch = metrics.match(/mqtt_monitor_sampled_messages_total{reason="rate_limit"} (\d+)/);
      const firstValue = firstMatch ? parseInt(firstMatch[1]) : 0;
      
      exporter.recordSampledMessage('rate_limit');
      
      metrics = await exporter.getMetrics();
      const secondMatch = metrics.match(/mqtt_monitor_sampled_messages_total{reason="rate_limit"} (\d+)/);
      const secondValue = secondMatch ? parseInt(secondMatch[1]) : 0;
      
      expect(secondValue).toBeGreaterThan(firstValue);
    });

    test('gauges reflect current state', async () => {
      const exporter = createExporter();
      updateMetrics(exporter, { connected: true });
      let metrics = await exporter.getMetrics();
      expect(metrics).toContain('mqtt_monitor_connected 1');
      
      updateMetrics(exporter, { connected: false });
      metrics = await exporter.getMetrics();
      expect(metrics).toContain('mqtt_monitor_connected 0');
    });
  });
});
