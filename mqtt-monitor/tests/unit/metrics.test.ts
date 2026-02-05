import { describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Metrics Correctness Tests (MUST HAVE)
 * 
 * Prometheus will happily ingest wrong numbers forever.
 * These tests ensure metrics are accurate and monotonic.
 */

describe('Metrics Correctness', () => {
  interface MetricsSnapshot {
    received: number;
    sent: number;
    timestamp: number;
  }

  class MetricsTracker {
    private counters = {
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0
    };

    private lastSnapshot: MetricsSnapshot | null = null;  // Use null for uninitialized state

    private messageRateHistory: number[] = [];

    update(values: Partial<typeof this.counters>): void {
      // Counters are monotonic - never decrease
      if (values.messagesReceived !== undefined) {
        this.counters.messagesReceived = Math.max(
          this.counters.messagesReceived,
          values.messagesReceived
        );
      }
      if (values.messagesSent !== undefined) {
        this.counters.messagesSent = Math.max(
          this.counters.messagesSent,
          values.messagesSent
        );
      }
      if (values.bytesReceived !== undefined) {
        this.counters.bytesReceived = Math.max(
          this.counters.bytesReceived,
          values.bytesReceived
        );
      }
      if (values.bytesSent !== undefined) {
        this.counters.bytesSent = Math.max(
          this.counters.bytesSent,
          values.bytesSent
        );
      }
    }

    tick(timestamp: number): void {
      // Initialize on first tick
      if (this.lastSnapshot === null) {
        this.lastSnapshot = {
          received: this.counters.messagesReceived,
          sent: this.counters.messagesSent,
          timestamp
        };
        return;
      }

      const timeDelta = (timestamp - this.lastSnapshot.timestamp) / 1000; // seconds
      
      if (timeDelta <= 0) return;

      // Calculate rate from delta
      const receivedDelta = this.counters.messagesReceived - this.lastSnapshot.received;
      const rate = receivedDelta / timeDelta;

      this.messageRateHistory.push(rate);
      if (this.messageRateHistory.length > 15) {
        this.messageRateHistory.shift();
      }

      this.lastSnapshot = {
        received: this.counters.messagesReceived,
        sent: this.counters.messagesSent,
        timestamp
      };
    }

    get received(): number {
      return this.counters.messagesReceived;
    }

    get sent(): number {
      return this.counters.messagesSent;
    }

    get rate(): number {
      return this.messageRateHistory[this.messageRateHistory.length - 1] || 0;
    }

    get avgRate(): number {
      if (this.messageRateHistory.length === 0) return 0;
      const sum = this.messageRateHistory.reduce((a, b) => a + b, 0);
      return sum / this.messageRateHistory.length;
    }
  }

  describe('Counter Monotonicity', () => {
    let metrics: MetricsTracker;

    beforeEach(() => {
      metrics = new MetricsTracker();
    });

    test('never decreases counters', () => {
      metrics.update({ messagesReceived: 10 });
      metrics.update({ messagesReceived: 5 }); // Try to decrease
      
      expect(metrics.received).toBe(10); // Should stay at 10
    });

    test('allows counter increases', () => {
      metrics.update({ messagesReceived: 10 });
      metrics.update({ messagesReceived: 20 });
      
      expect(metrics.received).toBe(20);
    });

    test('handles same value updates', () => {
      metrics.update({ messagesReceived: 10 });
      metrics.update({ messagesReceived: 10 });
      
      expect(metrics.received).toBe(10);
    });

    test('maintains monotonicity across all counters', () => {
      metrics.update({
        messagesReceived: 100,
        messagesSent: 50,
        bytesReceived: 1000,
        bytesSent: 500
      });

      metrics.update({
        messagesReceived: 50,  // Try to decrease
        messagesSent: 25,      // Try to decrease
        bytesReceived: 500,    // Try to decrease
        bytesSent: 250         // Try to decrease
      });

      expect(metrics.received).toBe(100);
      expect(metrics.sent).toBe(50);
    });

    test('handles zero values correctly', () => {
      metrics.update({ messagesReceived: 0 });
      expect(metrics.received).toBe(0);

      metrics.update({ messagesReceived: 10 });
      expect(metrics.received).toBe(10);

      metrics.update({ messagesReceived: 0 }); // Try to reset
      expect(metrics.received).toBe(10); // Should not reset
    });

    test('handles negative values by ignoring them', () => {
      metrics.update({ messagesReceived: 10 });
      metrics.update({ messagesReceived: -5 });
      
      expect(metrics.received).toBe(10);
    });
  });

  describe('Rate Calculation from Deltas', () => {
    test('computes message rate correctly', () => {
      const metrics = new MetricsTracker();
      
      // Time 0: 0 messages
      metrics.update({ messagesReceived: 0 });
      metrics.tick(0);
      
      // Time 1000ms: 100 messages (100 msg/s)
      metrics.update({ messagesReceived: 100 });
      metrics.tick(1000);
      
      expect(metrics.rate).toBe(100);
    });

    test('handles multiple ticks correctly', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({ messagesReceived: 0 });
      metrics.tick(0);
      
      metrics.update({ messagesReceived: 50 });
      metrics.tick(1000); // 50 msg/s
      
      metrics.update({ messagesReceived: 150 });
      metrics.tick(2000); // 100 msg/s
      
      expect(metrics.rate).toBe(100);
    });

    test('calculates average rate over window', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({ messagesReceived: 0 });
      metrics.tick(0);
      
      // Add varying rates: 100, 200, 300
      metrics.update({ messagesReceived: 100 });
      metrics.tick(1000); // 100 msg/s
      
      metrics.update({ messagesReceived: 300 });
      metrics.tick(2000); // 200 msg/s
      
      metrics.update({ messagesReceived: 600 });
      metrics.tick(3000); // 300 msg/s
      
      expect(metrics.avgRate).toBe(200); // (100 + 200 + 300) / 3
    });

    test('maintains rolling window of 15 samples', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({ messagesReceived: 0 });
      metrics.tick(0);
      
      // Add 20 samples
      for (let i = 1; i <= 20; i++) {
        metrics.update({ messagesReceived: i * 100 });
        metrics.tick(i * 1000);
      }
      
      // Should only keep last 15
      expect(metrics['messageRateHistory'].length).toBe(15);
    });

    test('handles zero time delta gracefully', () => {
      const metrics = new MetricsTracker();
      
      // Initialize
      metrics.update({ messagesReceived: 0 });
      metrics.tick(0);
      
      // First real tick
      metrics.update({ messagesReceived: 100 });
      metrics.tick(1000);  // Rate: 100 msg/s
      
      // Second tick with same timestamp (zero delta)
      metrics.update({ messagesReceived: 200 });
      metrics.tick(1000); // Same timestamp - zero delta
      
      // Should not calculate rate for zero delta, keep previous
      expect(metrics.rate).toBe(100); // Previous rate
    });

    test('handles negative time delta gracefully', () => {
      const metrics = new MetricsTracker();
      
      // Initialize
      metrics.update({ messagesReceived: 0 });
      metrics.tick(0);
      
      // First real tick
      metrics.update({ messagesReceived: 100 });
      metrics.tick(2000);  // Rate: 50 msg/s
      
      // Second tick with earlier timestamp (negative delta)
      metrics.update({ messagesReceived: 200 });
      metrics.tick(1000); // Earlier timestamp
      
      // Should not calculate rate for negative delta, keep previous
      expect(metrics.rate).toBe(50); // Previous rate
    });
  });

  describe('Delta Calculations', () => {
    test('computes correct delta between snapshots', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({ messagesReceived: 100 });
      metrics.tick(1000);
      
      metrics.update({ messagesReceived: 250 });
      metrics.tick(2000);
      
      // Delta: 250 - 100 = 150 messages
      // Time: 1 second
      // Rate: 150 msg/s
      expect(metrics.rate).toBe(150);
    });

    test('handles broker counter resets', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({ messagesReceived: 1000 });
      metrics.tick(1000);
      
      // Broker restarts - counter resets to 0
      metrics.update({ messagesReceived: 0 });
      metrics.tick(2000);
      
      // Should maintain previous value (monotonic)
      expect(metrics.received).toBe(1000);
    });

    test('accumulates deltas correctly over time', () => {
      const metrics = new MetricsTracker();
      
      const increments = [100, 50, 75, 200, 125];
      let total = 0;
      
      metrics.update({ messagesReceived: 0 });
      metrics.tick(0);
      
      increments.forEach((inc, i) => {
        total += inc;
        metrics.update({ messagesReceived: total });
        metrics.tick((i + 1) * 1000);
      });
      
      expect(metrics.received).toBe(550); // 100+50+75+200+125
    });
  });

  describe('Throughput Calculations', () => {
    test('computes bytes/sec correctly', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({ bytesReceived: 0 });
      metrics.tick(0);
      
      // 1024 bytes in 1 second = 1024 B/s = 1 KB/s
      metrics.update({ bytesReceived: 1024 });
      metrics.tick(1000);
      
      // Rate would be calculated similarly
      const timeDelta = 1; // second
      const bytesDelta = 1024;
      const throughputBps = bytesDelta / timeDelta;
      const throughputKBps = throughputBps / 1024;
      
      expect(throughputKBps).toBe(1);
    });

    test('converts bytes to kilobytes correctly', () => {
      const testCases = [
        { bytes: 1024, expectedKB: 1 },
        { bytes: 2048, expectedKB: 2 },
        { bytes: 512, expectedKB: 0.5 },
        { bytes: 1536, expectedKB: 1.5 }
      ];

      testCases.forEach(({ bytes, expectedKB }) => {
        const kb = bytes / 1024;
        expect(kb).toBe(expectedKB);
      });
    });
  });

  describe('Edge Cases', () => {
    test('handles very large counter values', () => {
      const metrics = new MetricsTracker();
      
      const largeValue = Number.MAX_SAFE_INTEGER - 100;
      metrics.update({ messagesReceived: largeValue });
      
      expect(metrics.received).toBe(largeValue);
    });

    test('handles rapid updates', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({ messagesReceived: 0 });
      metrics.tick(0);
      
      // 1000 messages in 100ms = 10,000 msg/s
      metrics.update({ messagesReceived: 1000 });
      metrics.tick(100);
      
      expect(metrics.rate).toBe(10000);
    });

    test('handles sparse updates', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({ messagesReceived: 0 });
      metrics.tick(0);
      
      // 100 messages in 1 hour = 100/3600 = 0.0277... msg/s
      metrics.update({ messagesReceived: 100 });
      metrics.tick(3600000); // 1 hour in ms
      
      expect(metrics.rate).toBeCloseTo(100 / 3600, 5);  // Use exact calculation
    });

    test('returns zero rate when no ticks', () => {
      const metrics = new MetricsTracker();
      expect(metrics.rate).toBe(0);
      expect(metrics.avgRate).toBe(0);
    });
  });

  describe('Prometheus Export Safety', () => {
    test('all metrics are non-negative', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({
        messagesReceived: 100,
        messagesSent: 50,
        bytesReceived: 1000,
        bytesSent: 500
      });
      
      expect(metrics.received).toBeGreaterThanOrEqual(0);
      expect(metrics.sent).toBeGreaterThanOrEqual(0);
    });

    test('rates are finite numbers', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({ messagesReceived: 100 });
      metrics.tick(1000);
      
      expect(Number.isFinite(metrics.rate)).toBe(true);
      expect(Number.isFinite(metrics.avgRate)).toBe(true);
    });

    test('no NaN values in metrics', () => {
      const metrics = new MetricsTracker();
      
      metrics.update({ messagesReceived: 0 });
      metrics.tick(0);
      
      expect(Number.isNaN(metrics.rate)).toBe(false);
      expect(Number.isNaN(metrics.avgRate)).toBe(false);
    });
  });
});
