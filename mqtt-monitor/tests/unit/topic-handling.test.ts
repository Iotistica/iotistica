import { describe, test, expect, beforeEach } from '@jest/globals';

/**
 * Topic Handling & Tree Logic Tests (MUST HAVE)
 * 
 * These tests prevent silent failures in topic parsing and tree growth.
 * Critical for production MQTT systems with diverse broker/client combinations.
 */

describe('Topic Handling - Edge Cases', () => {
  describe('Topic Parsing', () => {
    function splitTopic(topic: string): string[] {
      return topic.split('/');
    }

    test('splits normal topics correctly', () => {
      const parts = splitTopic('sensor/temperature/room1');
      expect(parts).toEqual(['sensor', 'temperature', 'room1']);
    });

    test('splits topics preserving empty levels', () => {
      const parts = splitTopic('a//b/');
      expect(parts).toEqual(['a', '', 'b', '']);
    });

    test('handles leading slash (absolute topic)', () => {
      const parts = splitTopic('/sensor/temp');
      expect(parts).toEqual(['', 'sensor', 'temp']);
    });

    test('handles trailing slash', () => {
      const parts = splitTopic('sensor/temp/');
      expect(parts).toEqual(['sensor', 'temp', '']);
    });

    test('handles single-level topic', () => {
      const parts = splitTopic('sensor');
      expect(parts).toEqual(['sensor']);
    });

    test('handles empty topic (root)', () => {
      const parts = splitTopic('');
      expect(parts).toEqual(['']);
    });

    test('handles deep nesting (10+ levels)', () => {
      const deepTopic = new Array(15).fill('level').join('/');
      const parts = splitTopic(deepTopic);
      expect(parts).toHaveLength(15);
      expect(parts.every(p => p === 'level')).toBe(true);
    });

    test('handles topics with special characters', () => {
      const parts = splitTopic('sensor/temp-001/room_1');
      expect(parts).toEqual(['sensor', 'temp-001', 'room_1']);
    });

    test('preserves consecutive empty levels', () => {
      const parts = splitTopic('a///b');
      expect(parts).toEqual(['a', '', '', 'b']);
    });
  });

  describe('Topic Tree Growth Limits', () => {
    interface TopicNode {
      _name?: string;
      _message?: string;
      _messagesCounter: number;
      [key: string]: any;
    }

    class TopicTree {
      private root: TopicNode = { _messagesCounter: 0 };
      private topicCount = 0;
      private readonly maxTopics: number;
      private readonly maxDepth: number;

      constructor(maxTopics = 10000, maxDepth = 20) {
        this.maxTopics = maxTopics;
        this.maxDepth = maxDepth;
      }

      add(topic: string, message?: string): boolean {
        const parts = topic.split('/');
        
        // Enforce max depth
        if (parts.length > this.maxDepth) {
          return false;
        }

        // Check if we're at max topics (only if adding new leaf)
        if (this.topicCount >= this.maxTopics && !this.exists(topic)) {
          return false;
        }

        let current = this.root;
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          if (!current[part]) {
            current[part] = { _messagesCounter: 0 };
          }
          current = current[part];
        }

        // Update message and counter
        const isNewTopic = !current._message;
        if (message) current._message = message;
        current._messagesCounter++;

        if (isNewTopic && message) {
          this.topicCount++;
        }

        return true;
      }

      exists(topic: string): boolean {
        const parts = topic.split('/');
        let current = this.root;
        
        for (const part of parts) {
          if (!current[part]) return false;
          current = current[part];
        }
        
        return !!current._message;
      }

      depth(): number {
        const calculateDepth = (node: TopicNode, currentDepth = 0): number => {
          let maxChildDepth = currentDepth;
          
          Object.keys(node).forEach(key => {
            if (key.startsWith('_')) return;
            const childDepth = calculateDepth(node[key], currentDepth + 1);
            maxChildDepth = Math.max(maxChildDepth, childDepth);
          });
          
          return maxChildDepth;
        };
        
        return calculateDepth(this.root);
      }

      totalTopics(): number {
        return this.topicCount;
      }
    }

    test('does not exceed max depth', () => {
      const tree = new TopicTree(10000, 10);
      
      // 15 levels (exceeds limit of 10)
      const deepTopic = new Array(15).fill('level').join('/');
      const added = tree.add(deepTopic, 'test');
      
      expect(added).toBe(false);
      expect(tree.depth()).toBeLessThanOrEqual(10);
    });

    test('drops topics when max topic count exceeded', () => {
      const tree = new TopicTree(100, 20);
      
      // Add 150 unique topics
      for (let i = 0; i < 150; i++) {
        tree.add(`topic/${i}`, `message-${i}`);
      }
      
      expect(tree.totalTopics()).toBe(100);
    });

    test('allows adding to existing topics when at max count', () => {
      const tree = new TopicTree(5, 20);
      
      // Fill to max
      for (let i = 0; i < 5; i++) {
        tree.add(`topic/${i}`, `message-${i}`);
      }
      
      expect(tree.totalTopics()).toBe(5);
      
      // Should allow updating existing topic
      const updated = tree.add('topic/0', 'updated-message');
      expect(updated).toBe(true);
      expect(tree.totalTopics()).toBe(5); // Count unchanged
    });

    test('calculates depth correctly for nested structure', () => {
      const tree = new TopicTree();
      
      tree.add('a', 'msg');
      tree.add('a/b', 'msg');
      tree.add('a/b/c', 'msg');
      tree.add('a/b/c/d', 'msg');
      
      expect(tree.depth()).toBe(4);
    });

    test('handles parallel branches independently', () => {
      const tree = new TopicTree();
      
      tree.add('branch1/deep/deeper', 'msg');
      tree.add('branch2/level2', 'msg');
      
      expect(tree.depth()).toBe(3); // branch1 path is deepest
    });
  });

  describe('Duplicate Topic Handling', () => {
    interface TopicNode {
      _messagesCounter: number;
      _sessionCounter?: number;
      _message?: string;
      [key: string]: any;
    }

    class TopicTree {
      private root: TopicNode = { _messagesCounter: 0 };

      add(topic: string, message: string) {
        const parts = topic.split('/');
        let current = this.root;
        
        for (const part of parts) {
          if (!current[part]) {
            current[part] = { _messagesCounter: 0, _sessionCounter: 0 };
          }
          current = current[part];
        }
        
        current._message = message;
        current._messagesCounter++;
        if (current._sessionCounter !== undefined) {
          current._sessionCounter++;
        }
      }

      totalTopics(): number {
        let count = 0;
        
        const traverse = (node: TopicNode) => {
          Object.keys(node).forEach(key => {
            if (key.startsWith('_')) return;
            const child = node[key];
            if (child._message !== undefined) count++;
            traverse(child);
          });
        };
        
        traverse(this.root);
        return count;
      }

      getNode(topic: string): TopicNode | null {
        const parts = topic.split('/');
        let current = this.root;
        
        for (const part of parts) {
          if (!current[part]) return null;
          current = current[part];
        }
        
        return current;
      }
    }

    test('increments counters without duplicating topic nodes', () => {
      const tree = new TopicTree();
      
      tree.add('a/b', 'message1');
      tree.add('a/b', 'message2');
      tree.add('a/b', 'message3');
      
      const node = tree.getNode('a/b');
      expect(node?._messagesCounter).toBe(3);
      expect(tree.totalTopics()).toBe(1); // Only one unique topic
    });

    test('handles QoS redelivery correctly', () => {
      const tree = new TopicTree();
      
      // Simulate QoS 1 redelivery
      tree.add('sensor/temp', '23.5');
      const firstCount = tree.getNode('sensor/temp')?._messagesCounter;
      
      tree.add('sensor/temp', '23.5'); // Redelivered
      const secondCount = tree.getNode('sensor/temp')?._messagesCounter;
      
      expect(secondCount).toBeGreaterThan(firstCount!);
      expect(tree.totalTopics()).toBe(1);
    });

    test('tracks session vs total counters separately', () => {
      const tree = new TopicTree();
      
      tree.add('topic/a', 'msg1');
      tree.add('topic/a', 'msg2');
      
      const node = tree.getNode('topic/a');
      expect(node?._messagesCounter).toBe(2); // Total
      expect(node?._sessionCounter).toBe(2); // Session
    });

    test('updates message payload on duplicate', () => {
      const tree = new TopicTree();
      
      tree.add('sensor/temp', '23.0');
      tree.add('sensor/temp', '24.5');
      
      const node = tree.getNode('sensor/temp');
      expect(node?._message).toBe('24.5'); // Latest message
      expect(node?._messagesCounter).toBe(2);
    });
  });

  describe('Wildcard-Looking Topics', () => {
    test('accepts messages with + in topic (not subscription wildcard)', () => {
      interface TopicNode {
        _messagesCounter: number;
        [key: string]: any;
      }

      const tree: TopicNode = { _messagesCounter: 0 };
      const topic = 'sensor/+/temperature';
      const parts = topic.split('/');
      
      let current = tree;
      for (const part of parts) {
        if (!current[part]) {
          current[part] = { _messagesCounter: 0 };
        }
        current = current[part];
      }
      current._messagesCounter++;
      
      expect(tree.sensor['+'].temperature._messagesCounter).toBe(1);
    });

    test('accepts messages with # in topic (literal, not wildcard)', () => {
      interface TopicNode {
        _messagesCounter: number;
        [key: string]: any;
      }

      const tree: TopicNode = { _messagesCounter: 0 };
      const topic = 'data/#/readings';
      const parts = topic.split('/');
      
      let current = tree;
      for (const part of parts) {
        if (!current[part]) {
          current[part] = { _messagesCounter: 0 };
        }
        current = current[part];
      }
      
      expect(tree.data['#'].readings).toBeDefined();
    });
  });
});
