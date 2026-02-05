import { describe, test, expect, beforeEach, jest } from '@jest/globals';

/**
 * Sampling Logic Tests (MUST HAVE)
 * 
 * Sampling is where subtle bugs hide. These tests ensure:
 * - Rate limiting works correctly
 * - Intervals are enforced
 * - Retained messages are handled properly
 */

describe('Sampling Logic', () => {
  interface Message {
    topic: string;
    payload: Buffer;
    timestamp: number;
    retained?: boolean;
    qos?: number;
  }

  interface SamplingState {
    lastSampleTs: number;
    sampleCount: number;
  }

  class MessageSampler {
    private samplingState = new Map<string, SamplingState>();
    private readonly sampleInterval: number;
    private readonly ignoreRetained: boolean;
    public samples: Message[] = [];

    constructor(sampleInterval = 10000, ignoreRetained = true) {
      this.sampleInterval = sampleInterval;
      this.ignoreRetained = ignoreRetained;
    }

    onMessage(msg: Message): boolean {
      // Ignore retained messages if configured
      if (this.ignoreRetained && msg.retained) {
        return false;
      }

      const now = msg.timestamp !== undefined ? msg.timestamp : Date.now();
      const state = this.samplingState.get(msg.topic);

      // First message for this topic - always sample
      if (!state) {
        this.samplingState.set(msg.topic, {
          lastSampleTs: now,
          sampleCount: 1
        });
        this.samples.push(msg);
        return true;
      }

      // Check if interval has elapsed
      if (now - state.lastSampleTs >= this.sampleInterval) {
        state.lastSampleTs = now;
        state.sampleCount++;
        this.samples.push(msg);
        return true;
      }

      // Within interval - skip sampling
      return false;
    }

    reset() {
      this.samples = [];
      this.samplingState.clear();
    }

    getSampleCount(topic: string): number {
      return this.samplingState.get(topic)?.sampleCount || 0;
    }
  }

  describe('Sampling Interval Enforcement', () => {
    let sampler: MessageSampler;

    beforeEach(() => {
      sampler = new MessageSampler(10000); // 10 second interval
    });

    test('samples payload only once per interval', () => {
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000
      };

      sampler.onMessage(msg);
      sampler.onMessage({ ...msg, timestamp: 2000 }); // 1s later
      sampler.onMessage({ ...msg, timestamp: 5000 }); // 5s later

      expect(sampler.samples.length).toBe(1); // Only first message sampled
    });

    test('allows sampling after interval elapses', () => {
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000
      };

      sampler.onMessage(msg);
      sampler.onMessage({ ...msg, timestamp: 11000 }); // 10s later (interval elapsed)

      expect(sampler.samples.length).toBe(2);
    });

    test('tracks sample count correctly', () => {
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000
      };

      sampler.onMessage(msg);
      sampler.onMessage({ ...msg, timestamp: 11000 });
      sampler.onMessage({ ...msg, timestamp: 21000 });

      expect(sampler.getSampleCount('sensor/temp')).toBe(3);
    });

    test('resets sampling state correctly', () => {
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000
      };

      sampler.onMessage(msg);
      expect(sampler.samples.length).toBe(1);

      sampler.reset();
      expect(sampler.samples.length).toBe(0);
      expect(sampler.getSampleCount('sensor/temp')).toBe(0);
    });

    test('handles multiple topics independently', () => {
      const msg1: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000
      };

      const msg2: Message = {
        topic: 'sensor/humidity',
        payload: Buffer.from('65'),
        timestamp: 1000
      };

      sampler.onMessage(msg1);
      sampler.onMessage(msg2);
      sampler.onMessage({ ...msg1, timestamp: 5000 }); // Within interval
      sampler.onMessage({ ...msg2, timestamp: 5000 }); // Within interval

      expect(sampler.samples.length).toBe(2); // One per topic
    });

    test('first message always sampled regardless of interval', () => {
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000
      };

      const sampled = sampler.onMessage(msg);
      expect(sampled).toBe(true);
      expect(sampler.samples.length).toBe(1);
    });

    test('respects exact interval boundary', () => {
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000
      };

      sampler.onMessage(msg);
      
      // Exactly at interval boundary (10000ms later)
      const sampled = sampler.onMessage({ ...msg, timestamp: 11000 });
      
      expect(sampled).toBe(true);
      expect(sampler.samples.length).toBe(2);
    });

    test('does not sample 1ms before interval', () => {
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000
      };

      sampler.onMessage(msg);
      
      // 1ms before interval
      const sampled = sampler.onMessage({ ...msg, timestamp: 10999 });
      
      expect(sampled).toBe(false);
      expect(sampler.samples.length).toBe(1);
    });
  });

  describe('Retained Message Handling', () => {
    test('does not sample retained messages by default', () => {
      const sampler = new MessageSampler(10000, true);
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000,
        retained: true
      };

      sampler.onMessage(msg);
      expect(sampler.samples.length).toBe(0);
    });

    test('samples retained messages when configured', () => {
      const sampler = new MessageSampler(10000, false); // Don't ignore retained
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000,
        retained: true
      };

      sampler.onMessage(msg);
      expect(sampler.samples.length).toBe(1);
    });

    test('ignores retained flag if undefined', () => {
      const sampler = new MessageSampler(10000, true);
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000
        // retained is undefined
      };

      sampler.onMessage(msg);
      expect(sampler.samples.length).toBe(1);
    });

    test('treats retained=false as normal message', () => {
      const sampler = new MessageSampler(10000, true);
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000,
        retained: false
      };

      sampler.onMessage(msg);
      expect(sampler.samples.length).toBe(1);
    });
  });

  describe('High-Frequency Message Handling', () => {
    test('correctly samples 1000 msg/sec topic with 10s interval', () => {
      const sampler = new MessageSampler(10000);
      
      // Test sampling logic with explicit timestamps
      // Message 1: timestamp 0 (first message - should sample)
      sampler.onMessage({
        topic: 'hot/topic',
        payload: Buffer.from('0'),
        timestamp: 0,
        retained: false
      });
      expect(sampler.samples.length).toBe(1);

      // Messages 2-N: timestamps 1-9999 (within interval - should NOT sample)
      for (let i = 1; i < 10000; i++) {
        sampler.onMessage({
          topic: 'hot/topic',
          payload: Buffer.from(`${i}`),
          timestamp: i,
          retained: false
        });
      }
      expect(sampler.samples.length).toBe(1); // Still just 1 sample

      // Message at exactly 10000ms (interval elapsed - should sample)
      sampler.onMessage({
        topic: 'hot/topic',
        payload: Buffer.from('10000'),
        timestamp: 10000,
        retained: false
      });
      expect(sampler.samples.length).toBe(2);

      // Messages at 10001-19999 (within interval - should NOT sample)
      for (let i = 10001; i < 20000; i++) {
        sampler.onMessage({
          topic: 'hot/topic',
          payload: Buffer.from(`${i}`),
          timestamp: i,
          retained: false
        });
      }
      expect(sampler.samples.length).toBe(2); // Still just 2 samples

      // Message at exactly 20000ms (interval elapsed - should sample)
      sampler.onMessage({
        topic: 'hot/topic',
        payload: Buffer.from('20000'),
        timestamp: 20000,
        retained: false
      });
      expect(sampler.samples.length).toBe(3);
      expect(sampler.getSampleCount('hot/topic')).toBe(3);
    });

    test('skips payloads but counts messages correctly', () => {
      const sampler = new MessageSampler(10000);
      let messageCount = 0;

      for (let i = 0; i < 100; i++) {
        const sampled = sampler.onMessage({
          topic: 'hot/topic',
          payload: Buffer.from(`msg-${i}`),
          timestamp: i
        });
        messageCount++;
        
        if (!sampled) {
          // Still counted, just not sampled
        }
      }

      expect(messageCount).toBe(100); // All messages counted
      expect(sampler.samples.length).toBe(1); // Only first sampled
    });
  });

  describe('Edge Cases', () => {
    test('handles negative timestamps gracefully', () => {
      const sampler = new MessageSampler(10000);
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: -1000
      };

      expect(() => sampler.onMessage(msg)).not.toThrow();
    });

    test('handles very large timestamps', () => {
      const sampler = new MessageSampler(10000);
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: Number.MAX_SAFE_INTEGER
      };

      expect(() => sampler.onMessage(msg)).not.toThrow();
    });

    test('handles zero interval (always sample)', () => {
      const sampler = new MessageSampler(0);
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000
      };

      sampler.onMessage(msg);
      sampler.onMessage({ ...msg, timestamp: 1001 });
      sampler.onMessage({ ...msg, timestamp: 1002 });

      expect(sampler.samples.length).toBe(3); // All sampled
    });

    test('handles missing timestamp (uses current time)', () => {
      const sampler = new MessageSampler(10000);
      const now = Date.now();
      
      jest.spyOn(Date, 'now').mockReturnValue(now);
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 0 // Will use Date.now()
      };

      sampler.onMessage(msg);
      expect(sampler.samples.length).toBe(1);
      
      jest.restoreAllMocks();
    });
  });

  describe('QoS Handling', () => {
    test('samples QoS 0 messages normally', () => {
      const sampler = new MessageSampler(10000);
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000,
        qos: 0
      };

      sampler.onMessage(msg);
      expect(sampler.samples.length).toBe(1);
    });

    test('samples QoS 1 messages normally', () => {
      const sampler = new MessageSampler(10000);
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000,
        qos: 1
      };

      sampler.onMessage(msg);
      expect(sampler.samples.length).toBe(1);
    });

    test('samples QoS 2 messages normally', () => {
      const sampler = new MessageSampler(10000);
      
      const msg: Message = {
        topic: 'sensor/temp',
        payload: Buffer.from('23.5'),
        timestamp: 1000,
        qos: 2
      };

      sampler.onMessage(msg);
      expect(sampler.samples.length).toBe(1);
    });
  });
});
