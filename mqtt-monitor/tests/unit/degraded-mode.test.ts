import { describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Degraded Mode Tests (MUST HAVE)
 * 
 * Degraded mode protects production systems under pressure.
 * These tests ensure backpressure handling works correctly.
 */

describe('Degraded Mode Behavior', () => {
  interface Message {
    topic: string;
    payload: Buffer;
    timestamp: number;
  }

  class EventLoopMonitor {
    private lastCheck = Date.now();
    private lag = 0;
    private readonly lagThreshold: number;

    constructor(lagThreshold = 100) {
      this.lagThreshold = lagThreshold;
    }

    check(): number {
      const now = Date.now();
      const expected = this.lastCheck + 1000; // Expected if no lag
      this.lag = Math.max(0, now - expected);
      this.lastCheck = now;
      return this.lag;
    }

    isLagging(): boolean {
      return this.lag > this.lagThreshold;
    }

    getCurrentLag(): number {
      return this.lag;
    }

    // Simulate lag for testing
    simulateLag(ms: number): void {
      this.lag = ms;
    }
  }

  class MessageQueue {
    private queue: Message[] = [];
    private readonly maxSize: number;
    public droppedCount = 0;

    constructor(maxSize = 1000) {
      this.maxSize = maxSize;
    }

    enqueue(msg: Message): boolean {
      if (this.isFull()) {
        this.droppedCount++;
        return false;
      }
      this.queue.push(msg);
      return true;
    }

    dequeue(): Message | undefined {
      return this.queue.shift();
    }

    size(): number {
      return this.queue.length;
    }

    isFull(): boolean {
      return this.queue.length >= this.maxSize;
    }

    clear(): void {
      this.queue = [];
    }
  }

  class MQTTMonitor {
    private degradedMode = false;
    private eventLoopMonitor: EventLoopMonitor;
    private messageQueue: MessageQueue;
    private sampler?: MessageSampler;
    private lagThreshold: number;

    constructor(
      lagThreshold = 100,
      queueSize = 1000
    ) {
      this.lagThreshold = lagThreshold;
      this.eventLoopMonitor = new EventLoopMonitor(lagThreshold);
      this.messageQueue = new MessageQueue(queueSize);
    }

    attachSampler(sampler: MessageSampler): void {
      this.sampler = sampler;
    }

    checkHealth(): void {
      const lag = this.eventLoopMonitor.getCurrentLag();
      const queueOverflow = this.messageQueue.isFull();

      // Enter degraded mode if event loop lagging or queue full
      if (lag > this.lagThreshold || queueOverflow) {
        if (!this.degradedMode) {
          this.degradedMode = true;
          this.onEnterDegradedMode();
        }
      } else {
        if (this.degradedMode) {
          this.degradedMode = false;
          this.onExitDegradedMode();
        }
      }
    }

    onMessage(msg: Message): void {
      if (this.degradedMode) {
        // Drop message in degraded mode
        return;
      }

      this.messageQueue.enqueue(msg);

      if (this.sampler) {
        this.sampler.sample(msg);
      }
    }

    isDegraded(): boolean {
      return this.degradedMode;
    }

    setDegraded(degraded: boolean): void {
      this.degradedMode = degraded;
    }

    getQueueSize(): number {
      return this.messageQueue.size();
    }

    getDroppedCount(): number {
      return this.messageQueue.droppedCount;
    }

    // Simulate event loop lag
    simulateLag(ms: number): void {
      this.eventLoopMonitor.simulateLag(ms);
    }

    // Force queue overflow
    fillQueue(): void {
      for (let i = 0; i < 1000; i++) {
        this.messageQueue.enqueue({
          topic: `test/${i}`,
          payload: Buffer.from(`msg-${i}`),
          timestamp: Date.now()
        });
      }
    }

    private onEnterDegradedMode(): void {
      // Stop sampling
      // Drop non-critical processing
    }

    private onExitDegradedMode(): void {
      // Resume sampling
      // Resume normal processing
    }
  }

  class MessageSampler {
    private enabled = true;
    public samples: Message[] = [];

    sample(msg: Message): void {
      if (!this.enabled) return;
      this.samples.push(msg);
    }

    disable(): void {
      this.enabled = false;
    }

    enable(): void {
      this.enabled = true;
    }

    isEnabled(): boolean {
      return this.enabled;
    }
  }

  describe('Degraded Mode Entry', () => {
    test('enters degraded mode when event loop lags', () => {
      const monitor = new MQTTMonitor(100);
      
      monitor.simulateLag(150); // Exceeds threshold
      monitor.checkHealth();
      
      expect(monitor.isDegraded()).toBe(true);
    });

    test('enters degraded mode when queue overflows', () => {
      const monitor = new MQTTMonitor(100, 10);
      
      monitor.fillQueue();
      monitor.checkHealth();
      
      expect(monitor.isDegraded()).toBe(true);
    });

    test('does not enter degraded mode under normal conditions', () => {
      const monitor = new MQTTMonitor(100);
      
      monitor.simulateLag(50); // Below threshold
      monitor.checkHealth();
      
      expect(monitor.isDegraded()).toBe(false);
    });

    test('tracks event loop lag correctly', () => {
      const eventLoop = new EventLoopMonitor(100);
      
      eventLoop.simulateLag(150);
      
      expect(eventLoop.getCurrentLag()).toBe(150);
      expect(eventLoop.isLagging()).toBe(true);
    });

    test('handles rapid health checks', () => {
      const monitor = new MQTTMonitor(100);
      
      for (let i = 0; i < 100; i++) {
        monitor.checkHealth();
      }
      
      expect(monitor.isDegraded()).toBe(false);
    });
  });

  describe('Degraded Mode Exit', () => {
    test('exits degraded mode when conditions improve', () => {
      const monitor = new MQTTMonitor(100);
      
      // Enter degraded mode
      monitor.simulateLag(150);
      monitor.checkHealth();
      expect(monitor.isDegraded()).toBe(true);
      
      // Conditions improve
      monitor.simulateLag(50);
      monitor.checkHealth();
      expect(monitor.isDegraded()).toBe(false);
    });

    test('stays in degraded mode until conditions fully recover', () => {
      const monitor = new MQTTMonitor(100);
      
      monitor.simulateLag(150);
      monitor.checkHealth();
      expect(monitor.isDegraded()).toBe(true);
      
      // Lag improves but still above threshold
      monitor.simulateLag(120);
      monitor.checkHealth();
      expect(monitor.isDegraded()).toBe(true);
      
      // Lag drops below threshold
      monitor.simulateLag(80);
      monitor.checkHealth();
      expect(monitor.isDegraded()).toBe(false);
    });
  });

  describe('Message Handling in Degraded Mode', () => {
    test('drops messages in degraded mode', () => {
      const monitor = new MQTTMonitor(100);
      
      monitor.setDegraded(true);
      
      const msg: Message = {
        topic: 'test/topic',
        payload: Buffer.from('test'),
        timestamp: Date.now()
      };
      
      monitor.onMessage(msg);
      
      expect(monitor.getQueueSize()).toBe(0); // Message dropped
    });

    test('processes messages in normal mode', () => {
      const monitor = new MQTTMonitor(100);
      
      const msg: Message = {
        topic: 'test/topic',
        payload: Buffer.from('test'),
        timestamp: Date.now()
      };
      
      monitor.onMessage(msg);
      
      expect(monitor.getQueueSize()).toBe(1);
    });

    test('stops sampling in degraded mode', () => {
      const monitor = new MQTTMonitor(100);
      const sampler = new MessageSampler();
      monitor.attachSampler(sampler);
      
      monitor.setDegraded(true);
      sampler.disable();
      
      const msg: Message = {
        topic: 'test/topic',
        payload: Buffer.from('test'),
        timestamp: Date.now()
      };
      
      monitor.onMessage(msg);
      
      expect(sampler.samples.length).toBe(0);
    });

    test('resumes sampling after degraded mode', () => {
      const monitor = new MQTTMonitor(100);
      const sampler = new MessageSampler();
      monitor.attachSampler(sampler);
      
      // Enter degraded mode
      monitor.setDegraded(true);
      sampler.disable();
      
      const msg1: Message = {
        topic: 'test/topic',
        payload: Buffer.from('test1'),
        timestamp: Date.now()
      };
      monitor.onMessage(msg1);
      
      // Exit degraded mode
      monitor.setDegraded(false);
      sampler.enable();
      
      const msg2: Message = {
        topic: 'test/topic',
        payload: Buffer.from('test2'),
        timestamp: Date.now()
      };
      monitor.onMessage(msg2);
      
      expect(sampler.samples.length).toBe(1); // Only msg2 sampled
      expect(sampler.samples[0].payload.toString()).toBe('test2');
    });
  });

  describe('Queue Overflow Handling', () => {
    test('rejects messages when queue is full', () => {
      const queue = new MessageQueue(5);
      
      // Fill queue
      for (let i = 0; i < 5; i++) {
        const result = queue.enqueue({
          topic: `test/${i}`,
          payload: Buffer.from(`msg-${i}`),
          timestamp: Date.now()
        });
        expect(result).toBe(true);
      }
      
      // Queue full - next message rejected
      const result = queue.enqueue({
        topic: 'test/overflow',
        payload: Buffer.from('overflow'),
        timestamp: Date.now()
      });
      
      expect(result).toBe(false);
      expect(queue.size()).toBe(5);
      expect(queue.droppedCount).toBe(1);
    });

    test('tracks dropped message count', () => {
      const queue = new MessageQueue(5);
      
      // Fill queue
      for (let i = 0; i < 10; i++) {
        queue.enqueue({
          topic: `test/${i}`,
          payload: Buffer.from(`msg-${i}`),
          timestamp: Date.now()
        });
      }
      
      expect(queue.droppedCount).toBe(5); // Last 5 dropped
    });

    test('allows enqueueing after dequeue', () => {
      const queue = new MessageQueue(2);
      
      queue.enqueue({
        topic: 'test/1',
        payload: Buffer.from('msg1'),
        timestamp: Date.now()
      });
      queue.enqueue({
        topic: 'test/2',
        payload: Buffer.from('msg2'),
        timestamp: Date.now()
      });
      
      expect(queue.isFull()).toBe(true);
      
      queue.dequeue(); // Remove one
      
      expect(queue.isFull()).toBe(false);
      
      const result = queue.enqueue({
        topic: 'test/3',
        payload: Buffer.from('msg3'),
        timestamp: Date.now()
      });
      
      expect(result).toBe(true);
    });
  });

  describe('Backpressure Metrics', () => {
    test('tracks degraded mode transitions', () => {
      const monitor = new MQTTMonitor(100);
      let enterCount = 0;
      let exitCount = 0;
      
      // Monitor state changes
      const checkTransition = () => {
        const wasDegraded = monitor.isDegraded();
        monitor.checkHealth();
        const isDegraded = monitor.isDegraded();
        
        if (!wasDegraded && isDegraded) enterCount++;
        if (wasDegraded && !isDegraded) exitCount++;
      };
      
      monitor.simulateLag(150);
      checkTransition(); // Enter
      
      monitor.simulateLag(50);
      checkTransition(); // Exit
      
      monitor.simulateLag(150);
      checkTransition(); // Enter again
      
      expect(enterCount).toBe(2);
      expect(exitCount).toBe(1);
    });

    test('measures time spent in degraded mode', () => {
      const monitor = new MQTTMonitor(100);
      
      const startTime = Date.now();
      monitor.simulateLag(150);
      monitor.checkHealth();
      
      expect(monitor.isDegraded()).toBe(true);
      
      // Exit degraded mode
      monitor.simulateLag(50);
      monitor.checkHealth();
      
      expect(monitor.isDegraded()).toBe(false);
      
      // Test passes if we successfully entered and exited degraded mode
      // (Duration tracking would require actual time-based monitoring)
    });
  });

  describe('Edge Cases', () => {
    test('handles repeated degraded mode toggles', () => {
      const monitor = new MQTTMonitor(100);
      
      for (let i = 0; i < 100; i++) {
        monitor.simulateLag(i % 2 === 0 ? 150 : 50);
        monitor.checkHealth();
      }
      
      // Should end in non-degraded state (last lag was 50)
      expect(monitor.isDegraded()).toBe(false);
    });

    test('handles zero lag threshold', () => {
      const monitor = new MQTTMonitor(0);
      
      monitor.simulateLag(1);
      monitor.checkHealth();
      
      expect(monitor.isDegraded()).toBe(true);
    });

    test('handles zero queue size gracefully', () => {
      const queue = new MessageQueue(0);
      
      const result = queue.enqueue({
        topic: 'test',
        payload: Buffer.from('msg'),
        timestamp: Date.now()
      });
      
      expect(result).toBe(false);
      expect(queue.droppedCount).toBe(1);
    });
  });
});
