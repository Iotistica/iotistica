import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import request from 'supertest';
import fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { EventEmitter } from 'events';

// Mock MQTT Monitor Service
class MockMQTTMonitorService extends EventEmitter {
  private connected = false;
  private topicTree: any = {
    _name: 'root',
    _topic: '',
    _created: Date.now(),
    _messagesCounter: 0,
    _topicsCounter: 0
  };
  private metrics: any = {
    messageRate: {
      published: Array(15).fill(0),
      received: Array(15).fill(0),
      current: { published: 0, received: 0 }
    },
    throughput: {
      inbound: Array(15).fill(0),
      outbound: Array(15).fill(0),
      current: { inbound: 0, outbound: 0 }
    },
    clients: 0,
    subscriptions: 0,
    retainedMessages: 0,
    totalMessagesSent: 0,
    totalMessagesReceived: 0,
    timestamp: Date.now()
  };
  private systemStats: any = { _name: 'broker' };
  
  async start() {
    this.connected = true;
    this.emit('connected');
  }
  
  async stop() {
    this.connected = false;
  }
  
  getStatus() {
    let topicCount = 0;
    let messageCount = 0;
    
    const traverse = (node: any) => {
      Object.keys(node).forEach(key => {
        if (key.startsWith('_')) return;
        const child = node[key];
        if (child._message !== undefined) {
          topicCount++;
          messageCount += child._messagesCounter || 0;
        }
        traverse(child);
      });
    };
    
    traverse(this.topicTree);
    
    return {
      connected: this.connected,
      topicCount,
      messageCount
    };
  }
  
  getTopicTree() {
    return this.topicTree;
  }
  
  getMetrics() {
    return this.metrics;
  }
  
  getSystemStats() {
    return this.systemStats;
  }
  
  getFlattenedTopics(filterTimestamp?: number | null) {
    const topics: any[] = [];
    
    const traverse = (node: any, parentPath = '') => {
      Object.keys(node).forEach(key => {
        if (key.startsWith('_')) return;
        
        const child = node[key];
        const fullPath = parentPath ? `${parentPath}/${key}` : key;
        
        if (child._message !== undefined) {
          if (!filterTimestamp || (child._lastModified && child._lastModified >= filterTimestamp)) {
            topics.push({
              topic: fullPath,
              messageCount: child._messagesCounter || 0,
              sessionCount: child._sessionCounter || 0,
              lastMessage: child._message,
              messageType: child._messageType,
              schema: child._schema,
              lastModified: child._lastModified
            });
          }
        }
        
        traverse(child, fullPath);
      });
    };
    
    traverse(this.topicTree);
    return topics;
  }
  
  syncToDatabase() {
    return Promise.resolve();
  }
  
  // Test helpers
  addTestTopic(topic: string, messageCount: number, messageType: string = 'json') {
    const parts = topic.split('/');
    let current = this.topicTree;
    
    parts.forEach((part, index) => {
      const isLeaf = index === parts.length - 1;
      const topicPath = parts.slice(0, index + 1).join('/');
      
      if (!current[part]) {
        current[part] = {
          _name: part,
          _topic: topicPath,
          _created: Date.now(),
          _messagesCounter: 0,
          _topicsCounter: 0
        };
      }
      
      if (isLeaf) {
        current[part]._messagesCounter = messageCount;
        current[part]._sessionCounter = messageCount;
        current[part]._message = messageType === 'json' ? '{"test":true}' : 'test';
        current[part]._messageType = messageType;
        current[part]._lastModified = Date.now();
      }
      
      current = current[part];
    });
  }
}

// Create test app
const createTestApp = () => {
  const app = fastify();
  void app.register(fastifyCors);
  
  const monitor = new MockMQTTMonitorService();
  
  // Health endpoint
  app.get('/health', async () => ({ status: 'healthy' }));
  
  // Ready endpoint
  app.get('/ready', async () => ({ status: 'ready', monitor: monitor.getStatus().connected }));
  
  // Status endpoint
  app.get('/api/v1/status', async (_req, reply) => {
    try {
      const status = monitor.getStatus();
      return reply.send({ success: true, data: status });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });
  
  // Start endpoint
  app.post('/api/v1/start', async (_req, reply) => {
    try {
      await monitor.start();
      return reply.send({ success: true, message: 'MQTT monitor started' });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });
  
  // Stop endpoint
  app.post('/api/v1/stop', async (_req, reply) => {
    try {
      await monitor.stop();
      return reply.send({ success: true, message: 'MQTT monitor stopped' });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });
  
  // Topic tree endpoint
  app.get('/api/v1/topic-tree', async (_req, reply) => {
    try {
      const tree = monitor.getTopicTree();
      return reply.send({ success: true, data: tree });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });
  
  // Topics endpoint
  app.get<{ Querystring: { timeWindow?: string; minutes?: string } }>('/api/v1/topics', async (req, reply) => {
    try {
      const { timeWindow, minutes } = req.query;
      let filterTimestamp: number | null = null;
      
      if (timeWindow) {
        const windows: Record<string, number> = {
          '1h': 60 * 60 * 1000,
          '6h': 6 * 60 * 60 * 1000,
          '24h': 24 * 60 * 60 * 1000,
          '7d': 7 * 24 * 60 * 60 * 1000,
          '30d': 30 * 24 * 60 * 60 * 1000
        };
        const windowMs = windows[timeWindow as string];
        if (windowMs) {
          filterTimestamp = Date.now() - windowMs;
        }
      } else if (minutes) {
        filterTimestamp = Date.now() - (parseInt(minutes as string) * 60 * 1000);
      }
      
      const topics = monitor.getFlattenedTopics(filterTimestamp);
      
      return reply.send({
        success: true,
        count: topics.length,
        data: topics,
        timeWindow: timeWindow || null,
        filteredFrom: filterTimestamp ? new Date(filterTimestamp).toISOString() : null
      });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });
  
  // Metrics endpoint
  app.get('/api/v1/metrics', async (_req, reply) => {
    try {
      const metrics = monitor.getMetrics();
      return reply.send({ success: true, data: metrics });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });
  
  // System stats endpoint
  app.get('/api/v1/system-stats', async (_req, reply) => {
    try {
      const stats = monitor.getSystemStats();
      return reply.send({ success: true, data: stats });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });
  
  // Stats endpoint (comprehensive)
  app.get('/api/v1/stats', async (_req, reply) => {
    try {
      const status = monitor.getStatus();
      const metrics = monitor.getMetrics();
      const systemStats = monitor.getSystemStats();
      
      return reply.send({
        success: true,
        data: {
          status,
          metrics,
          systemStats
        }
      });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });
  
  // Sync endpoint
  app.post('/api/v1/sync', async (_req, reply) => {
    try {
      await monitor.syncToDatabase();
      return reply.send({ success: true, message: 'Database sync triggered' });
    } catch (error: any) {
      return reply.status(500).send({ success: false, error: error.message });
    }
  });
  
  // 404 handler
  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: 'Not found' });
  });
  
  return { app, monitor };
};

describe('MQTT Monitor Server Integration Tests', () => {
  let app: FastifyInstance;
  let monitor: MockMQTTMonitorService;
  
  beforeAll(async () => {
    const result = createTestApp();
    app = result.app;
    monitor = result.monitor;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });
  
  beforeEach(() => {
    // Reset monitor state
    monitor['topicTree'] = {
      _name: 'root',
      _topic: '',
      _created: Date.now(),
      _messagesCounter: 0,
      _topicsCounter: 0
    };
  });
  
  describe('Basic Endpoints', () => {
    describe('GET /health', () => {
      test('should return healthy status', async () => {
        const response = await request(app.server).get('/health');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'healthy');
      });
    });
    
    describe('GET /ready', () => {
      test('should return readiness status', async () => {
        const response = await request(app.server).get('/ready');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'ready');
        expect(response.body).toHaveProperty('monitor');
      });
    });
    
    describe('404 Handler', () => {
      test('should return 404 for unknown routes', async () => {
        const response = await request(app.server).get('/nonexistent');
        
        expect(response.status).toBe(404);
        expect(response.body).toHaveProperty('error', 'Not found');
      });
    });
  });
  
  describe('Monitor Control', () => {
    describe('GET /api/v1/status', () => {
      test('should return monitor status', async () => {
        const response = await request(app.server).get('/api/v1/status');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('success', true);
        expect(response.body.data).toHaveProperty('connected');
        expect(response.body.data).toHaveProperty('topicCount');
        expect(response.body.data).toHaveProperty('messageCount');
      });
      
      test('should show correct counts after adding topics', async () => {
        monitor.addTestTopic('sensor/temperature', 10);
        monitor.addTestTopic('sensor/humidity', 5);
        
        const response = await request(app.server).get('/api/v1/status');
        
        expect(response.body.data.topicCount).toBe(2);
        expect(response.body.data.messageCount).toBe(15);
      });
    });
    
    describe('POST /api/v1/start', () => {
      test('should start monitor', async () => {
        const response = await request(app.server).post('/api/v1/start');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('success', true);
        expect(response.body).toHaveProperty('message', 'MQTT monitor started');
      });
    });
    
    describe('POST /api/v1/stop', () => {
      test('should stop monitor', async () => {
        await monitor.start();
        const response = await request(app.server).post('/api/v1/stop');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('success', true);
        expect(response.body).toHaveProperty('message', 'MQTT monitor stopped');
      });
    });
  });
  
  describe('Topic Monitoring', () => {
    beforeEach(() => {
      monitor.addTestTopic('sensor/temperature', 100, 'json');
      monitor.addTestTopic('sensor/humidity', 50, 'json');
      monitor.addTestTopic('system/status', 10, 'string');
    });
    
    describe('GET /api/v1/topic-tree', () => {
      test('should return hierarchical topic tree', async () => {
        const response = await request(app.server).get('/api/v1/topic-tree');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('success', true);
        expect(response.body.data).toHaveProperty('_name', 'root');
      });
    });
    
    describe('GET /api/v1/topics', () => {
      test('should return flattened topic list', async () => {
        const response = await request(app.server).get('/api/v1/topics');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('success', true);
        expect(response.body).toHaveProperty('count', 3);
        expect(response.body.data).toHaveLength(3);
      });
      
      test('should filter by time window', async () => {
        const response = await request(app.server).get('/api/v1/topics?timeWindow=1h');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('timeWindow', '1h');
        expect(response.body).toHaveProperty('filteredFrom');
      });
      
      test('should filter by minutes', async () => {
        const response = await request(app.server).get('/api/v1/topics?minutes=60');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('filteredFrom');
      });
      
      test('should include topic details', async () => {
        const response = await request(app.server).get('/api/v1/topics');
        
        const topic = response.body.data[0];
        expect(topic).toHaveProperty('topic');
        expect(topic).toHaveProperty('messageCount');
        expect(topic).toHaveProperty('messageType');
      });
    });
  });
  
  describe('Metrics & Statistics', () => {
    describe('GET /api/v1/metrics', () => {
      test('should return broker metrics', async () => {
        const response = await request(app.server).get('/api/v1/metrics');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('success', true);
        expect(response.body.data).toHaveProperty('messageRate');
        expect(response.body.data).toHaveProperty('throughput');
        expect(response.body.data).toHaveProperty('clients');
      });
      
      test('should include message rate arrays', async () => {
        const response = await request(app.server).get('/api/v1/metrics');
        
        expect(response.body.data.messageRate).toHaveProperty('published');
        expect(response.body.data.messageRate).toHaveProperty('received');
        expect(Array.isArray(response.body.data.messageRate.published)).toBe(true);
      });
    });
    
    describe('GET /api/v1/system-stats', () => {
      test('should return system statistics', async () => {
        const response = await request(app.server).get('/api/v1/system-stats');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('success', true);
        expect(response.body.data).toHaveProperty('_name', 'broker');
      });
    });
    
    describe('GET /api/v1/stats', () => {
      test('should return comprehensive statistics', async () => {
        const response = await request(app.server).get('/api/v1/stats');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('success', true);
        expect(response.body.data).toHaveProperty('status');
        expect(response.body.data).toHaveProperty('metrics');
        expect(response.body.data).toHaveProperty('systemStats');
      });
      
      test('should include all status fields', async () => {
        const response = await request(app.server).get('/api/v1/stats');
        
        expect(response.body.data.status).toHaveProperty('connected');
        expect(response.body.data.status).toHaveProperty('topicCount');
        expect(response.body.data.status).toHaveProperty('messageCount');
      });
    });
  });
  
  describe('Database Operations', () => {
    describe('POST /api/v1/sync', () => {
      test('should trigger database sync', async () => {
        const response = await request(app.server).post('/api/v1/sync');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('success', true);
        expect(response.body).toHaveProperty('message', 'Database sync triggered');
      });
    });
  });
  
  describe('CORS', () => {
    test('should have CORS headers', async () => {
      const response = await request(app.server)
        .get('/api/v1/status')
        .set('Origin', 'http://localhost:3000');
      
      expect(response.headers).toHaveProperty('access-control-allow-origin');
    });
  });
  
  describe('JSON Response Format', () => {
    test('should return JSON responses', async () => {
      const response = await request(app.server).get('/api/v1/status');
      
      expect(response.headers['content-type']).toMatch(/json/);
    });
    
    test('should have consistent success response structure', async () => {
      const response = await request(app.server).get('/api/v1/status');
      
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('data');
    });
  });
});
