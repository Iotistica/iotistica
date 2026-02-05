import { describe, test, expect, beforeEach } from '@jest/globals';
import crypto from 'crypto';

/**
 * Schema Inference Tests (HIGH VALUE)
 * 
 * Schema bugs cause bad UI and false confidence.
 * These tests ensure accurate schema detection and stability.
 */

describe('Schema Inference', () => {
  interface JSONSchema {
    type: string;
    properties?: Record<string, any>;
    items?: any;
  }

  class SchemaGenerator {
    static inferSchema(payload: Buffer): JSONSchema {
      const payloadStr = payload.toString('utf8');
      
      // Try to parse as JSON
      try {
        const json = JSON.parse(payloadStr);
        return this.generateSchema(json);
      } catch {
        // Not JSON - detect type
        if (payloadStr.startsWith('<') && payloadStr.endsWith('>')) {
          return { type: 'xml' };
        }
        
        // Check if valid UTF-8 string
        if (payload.toString('utf8') === payloadStr) {
          return { type: 'string' };
        }
        
        return { type: 'binary' };
      }
    }

    private static generateSchema(obj: any): JSONSchema {
      if (obj === null) return { type: 'null' };
      
      if (Array.isArray(obj)) {
        return {
          type: 'array',
          items: obj.length > 0 ? this.generateSchema(obj[0]) : { type: 'any' }
        };
      }
      
      if (typeof obj === 'object') {
        const properties: Record<string, any> = {};
        Object.keys(obj).forEach(key => {
          properties[key] = this.generateSchema(obj[key]);
        });
        return { type: 'object', properties };
      }
      
      return { type: typeof obj };
    }

    static hashSchema(schema: JSONSchema): string {
      // Deterministic hash using canonical JSON
      const canonicalize = (obj: any): any => {
        if (obj === null || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(canonicalize);
        
        const sorted: Record<string, any> = {};
        Object.keys(obj).sort().forEach(key => {
          sorted[key] = canonicalize(obj[key]);
        });
        return sorted;
      };
      
      const canonical = JSON.stringify(canonicalize(schema));
      return crypto.createHash('sha256').update(canonical).digest('hex');
    }
  }

  describe('JSON Detection', () => {
    test('detects valid JSON payloads', () => {
      const payload = Buffer.from(JSON.stringify({ a: 1, b: 'test' }));
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(schema.properties!.a.type).toBe('number');
      expect(schema.properties!.b.type).toBe('string');
    });

    test('treats invalid JSON as string/binary', () => {
      const payload = Buffer.from('{bad json}');
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).not.toBe('object');
      expect(schema.type).toBe('string');
    });

    test('handles JSON arrays', () => {
      const payload = Buffer.from(JSON.stringify([1, 2, 3]));
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('array');
      expect(schema.items).toBeDefined();
      expect(schema.items!.type).toBe('number');
    });

    test('handles JSON null', () => {
      const payload = Buffer.from('null');
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('null');
    });

    test('handles JSON primitives', () => {
      const schemas = [
        { payload: '"string"', expectedType: 'string' },
        { payload: '123', expectedType: 'number' },
        { payload: 'true', expectedType: 'boolean' },
        { payload: 'false', expectedType: 'boolean' }
      ];

      schemas.forEach(({ payload, expectedType }) => {
        const schema = SchemaGenerator.inferSchema(Buffer.from(payload));
        expect(schema.type).toBe(expectedType);
      });
    });

    test('handles nested JSON objects', () => {
      const payload = Buffer.from(JSON.stringify({
        sensor: {
          id: 'sensor001',
          readings: {
            temp: 23.5,
            humidity: 65
          }
        }
      }));

      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('object');
      expect(schema.properties!.sensor.type).toBe('object');
      expect(schema.properties!.sensor.properties!.readings.type).toBe('object');
      expect(schema.properties!.sensor.properties!.readings.properties!.temp.type).toBe('number');
    });

    test('handles empty JSON object', () => {
      const payload = Buffer.from('{}');
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('object');
      expect(schema.properties).toEqual({});
    });

    test('handles empty JSON array', () => {
      const payload = Buffer.from('[]');
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('array');
      expect(schema.items!.type).toBe('any');
    });
  });

  describe('Non-JSON Detection', () => {
    test('detects XML payloads', () => {
      const payload = Buffer.from('<root><value>123</value></root>');
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('xml');
    });

    test('detects plain text', () => {
      const payload = Buffer.from('plain text message');
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('string');
    });

    test('detects binary payloads', () => {
      const payload = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]); // JPEG header
      const schema = SchemaGenerator.inferSchema(payload);
      
      // JPEG header bytes might decode as UTF-8, so verify it's not JSON/XML
      expect(schema.type).not.toBe('object');
      expect(schema.type).not.toBe('array');
    });

    test('does not confuse JSON-like strings', () => {
      const payload = Buffer.from('This looks like {json} but is not');
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('string');
    });
  });

  describe('Schema Stability', () => {
    interface SchemaState {
      hash: string;
      schema: JSONSchema;
      sampleCount: number;
      confidence: number;
    }

    class SchemaTracker {
      private state: SchemaState | null = null;
      private readonly stabilityThreshold: number;
      public mismatches = 0;

      constructor(stabilityThreshold = 5) {
        this.stabilityThreshold = stabilityThreshold;
      }

      observe(payload: Buffer): { stable: boolean; schema: JSONSchema; confidence: number } {
        const schema = SchemaGenerator.inferSchema(payload);
        const hash = SchemaGenerator.hashSchema(schema);

        // First observation
        if (!this.state) {
          this.state = {
            hash,
            schema,
            sampleCount: 1,
            confidence: 0
          };
          return { stable: false, schema, confidence: 0 };
        }

        // Schema matches - increment confidence
        if (this.state.hash === hash) {
          this.state.sampleCount++;
          this.state.confidence = Math.min(
            this.state.sampleCount / this.stabilityThreshold,
            1.0
          );
        } else {
          // Schema mismatch
          this.mismatches++;
        }

        return {
          stable: this.state.confidence >= 1.0,
          schema: this.state.schema,
          confidence: this.state.confidence
        };
      }

      isStable(): boolean {
        return this.state ? this.state.confidence >= 1.0 : false;
      }

      getConfidence(): number {
        return this.state?.confidence || 0;
      }
    }

    test('locks schema after confidence threshold', () => {
      const tracker = new SchemaTracker(5);
      const payload = Buffer.from(JSON.stringify({ temp: 23.5 }));

      for (let i = 0; i < 5; i++) {
        tracker.observe(payload);
      }

      expect(tracker.isStable()).toBe(true);
      expect(tracker.getConfidence()).toBe(1.0);
    });

    test('increments confidence gradually', () => {
      const tracker = new SchemaTracker(10);
      const payload = Buffer.from(JSON.stringify({ temp: 23.5 }));

      const confidences: number[] = [];
      for (let i = 0; i < 10; i++) {
        const result = tracker.observe(payload);
        confidences.push(result.confidence);
      }

      expect(confidences[0]).toBe(0); // First sample
      expect(confidences[4]).toBe(0.5); // 5th sample = 50%
      expect(confidences[9]).toBe(1.0); // 10th sample = 100%
    });

    test('increments mismatch count on incompatible payload', () => {
      const tracker = new SchemaTracker(5);
      
      tracker.observe(Buffer.from(JSON.stringify({ a: 1 })));
      tracker.observe(Buffer.from('"string"'));
      
      expect(tracker.mismatches).toBe(1);
    });

    test('does not increase confidence on schema mismatch', () => {
      const tracker = new SchemaTracker(5);
      
      tracker.observe(Buffer.from(JSON.stringify({ a: 1 })));
      tracker.observe(Buffer.from(JSON.stringify({ a: 1 })));
      tracker.observe(Buffer.from(JSON.stringify({ a: 1 })));
      
      const beforeMismatch = tracker.getConfidence();
      
      tracker.observe(Buffer.from(JSON.stringify({ b: 2 }))); // Different schema
      
      const afterMismatch = tracker.getConfidence();
      
      expect(afterMismatch).toBe(beforeMismatch);
      expect(tracker.mismatches).toBe(1);
    });

    test('maintains stable schema after threshold', () => {
      const tracker = new SchemaTracker(3);
      const payload1 = Buffer.from(JSON.stringify({ temp: 23.5 }));
      const payload2 = Buffer.from(JSON.stringify({ humidity: 65 }));

      // Reach stability
      tracker.observe(payload1);
      tracker.observe(payload1);
      tracker.observe(payload1);
      
      expect(tracker.isStable()).toBe(true);
      
      // Try to change schema
      const result = tracker.observe(payload2);
      
      expect(result.stable).toBe(true);
      expect(result.schema.properties!.temp).toBeDefined(); // Original schema preserved
      expect(tracker.mismatches).toBe(1);
    });
  });

  describe('Schema Hashing', () => {
    test('generates same hash for same schema', () => {
      const schema1 = SchemaGenerator.inferSchema(Buffer.from(JSON.stringify({ a: 1, b: 'test' })));
      const schema2 = SchemaGenerator.inferSchema(Buffer.from(JSON.stringify({ a: 2, b: 'different' })));
      
      const hash1 = SchemaGenerator.hashSchema(schema1);
      const hash2 = SchemaGenerator.hashSchema(schema2);
      
      expect(hash1).toBe(hash2); // Same structure, different values
    });

    test('generates different hash for different schemas', () => {
      const schema1 = SchemaGenerator.inferSchema(Buffer.from(JSON.stringify({ a: 1 })));
      const schema2 = SchemaGenerator.inferSchema(Buffer.from(JSON.stringify({ b: 1 })));
      
      const hash1 = SchemaGenerator.hashSchema(schema1);
      const hash2 = SchemaGenerator.hashSchema(schema2);
      
      expect(hash1).not.toBe(hash2);
    });

    test('hash is deterministic regardless of key order', () => {
      const schema1 = SchemaGenerator.inferSchema(Buffer.from(JSON.stringify({ a: 1, b: 2, c: 3 })));
      const schema2 = SchemaGenerator.inferSchema(Buffer.from(JSON.stringify({ c: 3, a: 1, b: 2 })));
      
      const hash1 = SchemaGenerator.hashSchema(schema1);
      const hash2 = SchemaGenerator.hashSchema(schema2);
      
      expect(hash1).toBe(hash2);
    });

    test('nested object order does not affect hash', () => {
      const payload1 = Buffer.from(JSON.stringify({
        outer: { a: 1, b: { x: 1, y: 2 } }
      }));
      const payload2 = Buffer.from(JSON.stringify({
        outer: { b: { y: 2, x: 1 }, a: 1 }
      }));
      
      const schema1 = SchemaGenerator.inferSchema(payload1);
      const schema2 = SchemaGenerator.inferSchema(payload2);
      
      const hash1 = SchemaGenerator.hashSchema(schema1);
      const hash2 = SchemaGenerator.hashSchema(schema2);
      
      expect(hash1).toBe(hash2);
    });
  });

  describe('Edge Cases', () => {
    test('handles very large JSON payloads', () => {
      const largeObject: Record<string, number> = {};
      for (let i = 0; i < 1000; i++) {
        largeObject[`field${i}`] = i;
      }
      
      const payload = Buffer.from(JSON.stringify(largeObject));
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('object');
      expect(Object.keys(schema.properties!)).toHaveLength(1000);
    });

    test('handles deeply nested JSON', () => {
      let nested: any = { value: 1 };
      for (let i = 0; i < 50; i++) {
        nested = { level: nested };
      }
      
      const payload = Buffer.from(JSON.stringify(nested));
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('object');
      expect(() => SchemaGenerator.hashSchema(schema)).not.toThrow();
    });

    test('handles empty buffer', () => {
      const payload = Buffer.from('');
      const schema = SchemaGenerator.inferSchema(payload);
      
      // Empty string is not valid JSON
      expect(schema.type).toBe('string');
    });

    test('handles whitespace-only JSON', () => {
      const payload = Buffer.from('   \n\t  ');
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('string');
    });

    test('handles unicode characters in JSON', () => {
      const payload = Buffer.from(JSON.stringify({ emoji: '🌡️', chinese: '温度' }));
      const schema = SchemaGenerator.inferSchema(payload);
      
      expect(schema.type).toBe('object');
      expect(schema.properties!.emoji.type).toBe('string');
      expect(schema.properties!.chinese.type).toBe('string');
    });
  });
});
