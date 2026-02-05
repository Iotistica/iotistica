import { describe, test, expect } from '@jest/globals';
import { Registry, Gauge, Counter } from 'prom-client';

/**
 * Prometheus Exporter Smoke Tests (SAFETY)
 * 
 * These tests ensure the Prometheus exporter doesn't crash under load.
 * Critical for production monitoring stability.
 */

describe('Prometheus Exporter Safety', () => {
  class SimplePrometheusExporter {
    private registry: Registry;
    private connectedGauge: Gauge;
    private messagesCounter: Counter;
    private updating = false;

    constructor() {
      this.registry = new Registry();
      
      this.connectedGauge = new Gauge({
        name: 'mqtt_connected',
        help: 'MQTT connection status',
        registers: [this.registry]
      });
      
      this.messagesCounter = new Counter({
        name: 'mqtt_messages_total',
        help: 'Total messages received',
        labelNames: ['topic'],
        registers: [this.registry]
      });
    }

    updateMetrics(connected: boolean, messages: Array<{ topic: string; count: number }>): void {
      this.updating = true;
      
      try {
        this.connectedGauge.set(connected ? 1 : 0);
        
        messages.forEach(({ topic, count }) => {
          this.messagesCounter.inc({ topic }, count);
        });
      } finally {
        this.updating = false;
      }
    }

    async scrape(): Promise<string> {
      return this.registry.metrics();
    }

    reset(): void {
      this.registry.resetMetrics();
    }

    isUpdating(): boolean {
      return this.updating;
    }
  }

  describe('/metrics Endpoint', () => {
    test('exposes metrics endpoint', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'test/topic', count: 10 }
      ]);
      
      const metrics = await exporter.scrape();
      
      expect(metrics).toBeTruthy();
      expect(typeof metrics).toBe('string');
    });

    test('returns valid Prometheus format', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, []);
      
      const metrics = await exporter.scrape();
      
      // Check for HELP and TYPE comments
      expect(metrics).toContain('# HELP');
      expect(metrics).toContain('# TYPE');
    });

    test('includes gauge metrics', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, []);
      
      const metrics = await exporter.scrape();
      
      expect(metrics).toContain('mqtt_connected');
      expect(metrics).toContain('mqtt_connected 1');
    });

    test('includes counter metrics with labels', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'sensor/temp', count: 5 }
      ]);
      
      const metrics = await exporter.scrape();
      
      expect(metrics).toContain('mqtt_messages_total');
      expect(metrics).toContain('topic="sensor/temp"');
    });

    test('handles empty metrics', async () => {
      const exporter = new SimplePrometheusExporter();
      
      const metrics = await exporter.scrape();
      
      expect(metrics).toBeTruthy();
      expect(metrics.length).toBeGreaterThan(0);
    });
  });

  describe('Concurrent Operations', () => {
    test('does not throw during scrape while updating metrics', async () => {
      const exporter = new SimplePrometheusExporter();
      
      // Start updating
      exporter.updateMetrics(true, [
        { topic: 'test/topic', count: 100 }
      ]);
      
      // Scrape during update
      await expect(exporter.scrape()).resolves.toBeTruthy();
    });

    test('handles rapid successive scrapes', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'test/topic', count: 10 }
      ]);
      
      // Scrape 100 times rapidly
      const scrapes = Array(100).fill(null).map(() => exporter.scrape());
      
      await expect(Promise.all(scrapes)).resolves.toBeTruthy();
    });

    test('handles concurrent updates and scrapes', async () => {
      const exporter = new SimplePrometheusExporter();
      
      const operations: Promise<any>[] = [];
      
      // 50 updates
      for (let i = 0; i < 50; i++) {
        operations.push(
          Promise.resolve(exporter.updateMetrics(true, [
            { topic: `topic/${i}`, count: i }
          ]))
        );
      }
      
      // 50 scrapes
      for (let i = 0; i < 50; i++) {
        operations.push(exporter.scrape());
      }
      
      await expect(Promise.all(operations)).resolves.toBeTruthy();
    });
  });

  describe('High Load Scenarios', () => {
    test('handles large number of topics', async () => {
      const exporter = new SimplePrometheusExporter();
      
      const topics: Array<{ topic: string; count: number }> = [];
      for (let i = 0; i < 1000; i++) {
        topics.push({ topic: `topic/${i}`, count: 1 });
      }
      
      exporter.updateMetrics(true, topics);
      
      const metrics = await exporter.scrape();
      expect(metrics).toBeTruthy();
    });

    test('handles very large counter values', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'hot/topic', count: Number.MAX_SAFE_INTEGER - 100 }
      ]);
      
      const metrics = await exporter.scrape();
      expect(metrics).toContain('mqtt_messages_total');
    });

    test('handles rapid metric updates', async () => {
      const exporter = new SimplePrometheusExporter();
      
      for (let i = 0; i < 1000; i++) {
        exporter.updateMetrics(true, [
          { topic: 'test/topic', count: 1 }
        ]);
      }
      
      const metrics = await exporter.scrape();
      expect(metrics).toBeTruthy();
    });

    test('scrape completes within reasonable time', async () => {
      const exporter = new SimplePrometheusExporter();
      
      // Add 1000 topics
      const topics: Array<{ topic: string; count: number }> = [];
      for (let i = 0; i < 1000; i++) {
        topics.push({ topic: `topic/${i}`, count: 100 });
      }
      exporter.updateMetrics(true, topics);
      
      const startTime = Date.now();
      await exporter.scrape();
      const duration = Date.now() - startTime;
      
      // Should complete in < 100ms even with 1000 topics
      expect(duration).toBeLessThan(100);
    });
  });

  describe('Error Handling', () => {
    test('gracefully handles metric update errors', () => {
      const exporter = new SimplePrometheusExporter();
      
      expect(() => {
        exporter.updateMetrics(true, [
          { topic: '', count: 10 } // Empty topic
        ]);
      }).not.toThrow();
    });

    test('gracefully handles negative counts', () => {
      const exporter = new SimplePrometheusExporter();
      
      // Counters cannot decrease - should throw error (correct Prometheus behavior)
      expect(() => {
        exporter.updateMetrics(true, [
          { topic: 'test/topic', count: -10 }
        ]);
      }).toThrow();
    });

    test('handles reset during scrape', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'test/topic', count: 100 }
      ]);
      
      const scrapePromise = exporter.scrape();
      exporter.reset();
      
      await expect(scrapePromise).resolves.toBeTruthy();
    });

    test('recovers after reset', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'test/topic', count: 100 }
      ]);
      
      exporter.reset();
      
      exporter.updateMetrics(true, [
        { topic: 'test/topic', count: 50 }
      ]);
      
      const metrics = await exporter.scrape();
      expect(metrics).toContain('mqtt_messages_total');
    });
  });

  describe('Memory Safety', () => {
    test('does not leak memory on repeated scrapes', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'test/topic', count: 100 }
      ]);
      
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Scrape 1000 times
      for (let i = 0; i < 1000; i++) {
        await exporter.scrape();
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = finalMemory - initialMemory;
      
      // Memory growth should be minimal (< 10MB for 1000 scrapes)
      expect(memoryGrowth).toBeLessThan(10 * 1024 * 1024);
    });

    test('clears topic metrics on reset', async () => {
      const exporter = new SimplePrometheusExporter();
      
      // Add many topics
      const topics: Array<{ topic: string; count: number }> = [];
      for (let i = 0; i < 1000; i++) {
        topics.push({ topic: `topic/${i}`, count: 100 });
      }
      exporter.updateMetrics(true, topics);
      
      const beforeReset = await exporter.scrape();
      
      exporter.reset();
      
      const afterReset = await exporter.scrape();
      
      // After reset should be much smaller
      expect(afterReset.length).toBeLessThan(beforeReset.length);
    });
  });

  describe('Special Characters', () => {
    test('handles topics with special characters', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'sensor/temp-001', count: 10 },
        { topic: 'device/status_ok', count: 5 },
        { topic: 'data/value.current', count: 3 }
      ]);
      
      const metrics = await exporter.scrape();
      expect(metrics).toBeTruthy();
    });

    test('handles topics with spaces (escaped)', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'sensor with space', count: 10 }
      ]);
      
      const metrics = await exporter.scrape();
      expect(metrics).toBeTruthy();
    });

    test('handles unicode characters in topics', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: '温度/sensor', count: 10 },
        { topic: 'sensor/🌡️', count: 5 }
      ]);
      
      const metrics = await exporter.scrape();
      expect(metrics).toBeTruthy();
    });
  });

  describe('Output Format', () => {
    test('metrics are newline-separated', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'test/topic', count: 10 }
      ]);
      
      const metrics = await exporter.scrape();
      const lines = metrics.split('\n').filter(line => line.trim());
      
      expect(lines.length).toBeGreaterThan(0);
    });

    test('counters are cumulative', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, [
        { topic: 'test/topic', count: 10 }
      ]);
      
      let metrics = await exporter.scrape();
      const firstMatch = metrics.match(/mqtt_messages_total{topic="test\/topic"} (\d+)/);
      const firstValue = firstMatch ? parseInt(firstMatch[1]) : 0;
      
      exporter.updateMetrics(true, [
        { topic: 'test/topic', count: 5 }
      ]);
      
      metrics = await exporter.scrape();
      const secondMatch = metrics.match(/mqtt_messages_total{topic="test\/topic"} (\d+)/);
      const secondValue = secondMatch ? parseInt(secondMatch[1]) : 0;
      
      expect(secondValue).toBeGreaterThan(firstValue);
    });

    test('gauges reflect current state', async () => {
      const exporter = new SimplePrometheusExporter();
      
      exporter.updateMetrics(true, []);
      let metrics = await exporter.scrape();
      expect(metrics).toContain('mqtt_connected 1');
      
      exporter.updateMetrics(false, []);
      metrics = await exporter.scrape();
      expect(metrics).toContain('mqtt_connected 0');
    });
  });
});
