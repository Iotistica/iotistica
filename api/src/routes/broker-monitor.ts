import type { FastifyPluginAsync } from 'fastify';
import { getBrokerMonitorService, getBrokerDbService, getBrokerHistoryService } from '../services/broker-monitor/index';
import logger from '../utils/logger';

interface TopicWindowQuerystring {
  timeWindow?: string;
  minutes?: string;
}

interface LimitQuerystring {
  limit?: string;
}

interface TopicActivityQuerystring {
  window?: string;
}

interface TopicFilterQuerystring {
  limit?: string;
  messageType?: string;
  hasSchema?: string;
}

interface TopicIdParams {
  topicId: string;
}

interface TopicParams {
  topic: string;
}

function parseTopicFilterTimestamp(timeWindow?: string, minutesParam?: string): number | null {
  if (timeWindow) {
    const now = Date.now();
    switch (timeWindow) {
      case '1h':
        return now - (60 * 60 * 1000);
      case '6h':
        return now - (6 * 60 * 60 * 1000);
      case '24h':
        return now - (24 * 60 * 60 * 1000);
      case '7d':
        return now - (7 * 24 * 60 * 60 * 1000);
      case '30d':
        return now - (30 * 24 * 60 * 60 * 1000);
      case 'all':
      default:
        return null;
    }
  }

  if (!minutesParam) {
    return null;
  }

  const minutes = parseInt(minutesParam, 10);
  if (Number.isNaN(minutes) || minutes <= 0) {
    return null;
  }

  return Date.now() - (minutes * 60 * 1000);
}

function decodeTopicParam(topic: string): string {
  try {
    return decodeURIComponent(topic);
  } catch {
    return topic;
  }
}

/** Returns a 503 response when this replica is not the broker-monitor leader. */
function notActive(reply: any) {
  return reply.status(503).send({
    success: false,
    error: 'broker-monitor not active on this instance'
  });
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/status', async (_request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return reply.send({
          success: true,
          data: {
            connected: false,
            message: 'Monitor not initialized'
          }
        });
      }

      return reply.send({
        success: true,
        data: monitor.getStatus()
      });
    } catch (error: any) {
      logger.error('Error getting status', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.post('/start', async (_request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return notActive(reply);
      }

      await monitor.start();
      logger.info('MQTT monitor started via API');
      return reply.send({ success: true, message: 'MQTT monitor started' });
    } catch (error: any) {
      logger.error('Error starting monitor', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.post('/stop', async (_request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return notActive(reply);
      }

      await monitor.stop();
      logger.info('MQTT monitor stopped via API');
      return reply.send({ success: true, message: 'MQTT monitor stopped' });
    } catch (error: any) {
      logger.error('Error stopping monitor', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get('/topic-tree', async (_request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return notActive(reply);
      }

      return reply.send({ success: true, data: monitor.getTopicTree() });
    } catch (error: any) {
      logger.error('Error getting topic tree', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get<{ Querystring: TopicWindowQuerystring }>('/topics', async (request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return notActive(reply);
      }

      const { timeWindow, minutes: minutesParam } = request.query;
      const filterTimestamp = parseTopicFilterTimestamp(timeWindow, minutesParam);
      const topics = monitor.getFlattenedTopics(filterTimestamp);

      return reply.send({
        success: true,
        count: topics.length,
        data: topics,
        timeWindow: timeWindow || (minutesParam ? `${minutesParam}m` : 'all'),
        filteredFrom: filterTimestamp ? new Date(filterTimestamp).toISOString() : null
      });
    } catch (error: any) {
      logger.error('Error getting topics', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get<{ Params: TopicIdParams }>('/topics/by-id/:topicId/schema', async (request, reply) => {
    try {
      const mqttDbService = getBrokerDbService();
      if (!mqttDbService) {
        return reply.status(400).send({ success: false, error: 'Database persistence not enabled' });
      }

      const { topicId } = request.params;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(topicId)) {
        return reply.status(400).send({ success: false, error: 'Invalid topic_id format' });
      }

      const topicRecord = await mqttDbService.getTopicById(topicId);
      if (!topicRecord) {
        return reply.status(404).send({ success: false, error: 'Topic not found' });
      }

      return reply.send({
        success: true,
        data: {
          topicId: topicRecord.topicId,
          topic: topicRecord.topic,
          schema: topicRecord.schema,
          messageType: topicRecord.messageType,
          lastMessage: topicRecord.lastMessage,
          messageCount: topicRecord.messageCount
        }
      });
    } catch (error: any) {
      logger.error('Error getting topic schema by ID', { error: error.message, topicId: request.params.topicId });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get<{ Params: TopicParams }>('/topics/:topic/schema', async (request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return notActive(reply);
      }

      const topic = decodeTopicParam(request.params.topic);
      const schemaData = monitor.getTopicSchema(topic);
      if (!schemaData) {
        return reply.status(404).send({ success: false, error: 'Topic not found or no schema available' });
      }

      return reply.send({
        success: true,
        data: {
          topic,
          ...schemaData
        }
      });
    } catch (error: any) {
      logger.error('Error getting topic schema', { error: error.message, topic: request.params.topic });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get('/metrics', async (_request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return notActive(reply);
      }

      const metrics = monitor.getMetrics();
      return reply.send({
        success: true,
        data: {
          messageRate: metrics.messageRate,
          throughput: metrics.throughput,
          clients: metrics.clients,
          subscriptions: metrics.subscriptions,
          retainedMessages: metrics.retainedMessages,
          totalMessages: {
            sent: metrics.totalMessagesSent,
            received: metrics.totalMessagesReceived
          },
          timestamp: metrics.timestamp
        }
      });
    } catch (error: any) {
      logger.error('Error getting metrics', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get('/system-stats', async (_request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return notActive(reply);
      }

      return reply.send({ success: true, data: monitor.getSystemStats() });
    } catch (error: any) {
      logger.error('Error getting system stats', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get('/stats', async (_request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return notActive(reply);
      }

      const status = monitor.getStatus();
      const metrics = monitor.getMetrics();
      const systemStats = monitor.getSystemStats();
      const topics = monitor.getFlattenedTopics();
      const topicsWithSchemas = topics.filter((topic) => topic.schema).length;
      const messageTypeBreakdown = topics.reduce<Record<string, number>>((accumulator, topic) => {
        if (topic.messageType) {
          accumulator[topic.messageType] = (accumulator[topic.messageType] || 0) + 1;
        }
        return accumulator;
      }, {});

      return reply.send({
        success: true,
        data: {
          connected: status.connected,
          topicCount: status.topicCount,
          messageCount: status.messageCount,
          schemas: {
            total: topicsWithSchemas,
            byType: messageTypeBreakdown
          },
          messageRate: {
            published: metrics.messageRate.current.published,
            received: metrics.messageRate.current.received
          },
          throughput: {
            inbound: metrics.throughput.current.inbound,
            outbound: metrics.throughput.current.outbound
          },
          clients: metrics.clients,
          subscriptions: metrics.subscriptions,
          retainedMessages: metrics.retainedMessages,
          totalMessagesSent: metrics.totalMessagesSent,
          totalMessagesReceived: metrics.totalMessagesReceived,
          broker: systemStats.$SYS?.broker || null
        }
      });
    } catch (error: any) {
      logger.error('Error getting comprehensive stats', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get<{ Querystring: LimitQuerystring }>('/stats/history', async (request, reply) => {
    try {
      const historyService = getBrokerHistoryService();
      if (!historyService) {
        return reply.status(404).send({ success: false, error: 'History service not available' });
      }

      const limitParam = request.query.limit;
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;
      const history = historyService.getHistory(limit);
      return reply.send({ success: true, count: history.length, history });
    } catch (error: any) {
      logger.error('Error getting stats history', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get('/dashboard', async (_request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return notActive(reply);
      }

      const status = monitor.getStatus();
      const topicTree = monitor.getTopicTree();
      const topics = monitor.getFlattenedTopics();
      const metrics = monitor.getMetrics();
      const topicsWithSchemas = topics.filter((topic) => topic.schema).length;

      return reply.send({
        success: true,
        data: {
          status,
          topicTree,
          topics: {
            count: topics.length,
            withSchemas: topicsWithSchemas,
            list: topics.slice(0, 100)
          },
          metrics: {
            messageRate: metrics.messageRate,
            throughput: metrics.throughput,
            clients: metrics.clients,
            subscriptions: metrics.subscriptions,
            retainedMessages: metrics.retainedMessages,
            totalMessages: {
              sent: metrics.totalMessagesSent,
              received: metrics.totalMessagesReceived
            }
          },
          timestamp: Date.now()
        }
      });
    } catch (error: any) {
      logger.error('Error getting dashboard data', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.post('/sync', async (_request, reply) => {
    try {
      const monitor = getBrokerMonitorService();
      if (!monitor) {
        return notActive(reply);
      }

      await monitor.flushToDatabase();
      logger.info('Manual database sync triggered');
      return reply.send({ success: true, message: 'Data synced to database' });
    } catch (error: any) {
      logger.error('Error syncing to database', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get<{ Querystring: TopicFilterQuerystring }>('/database/topics', async (request, reply) => {
    try {
      const mqttDbService = getBrokerDbService();
      if (!mqttDbService) {
        return reply.status(400).send({ success: false, error: 'Database persistence not enabled' });
      }

      const limit = request.query.limit ? parseInt(request.query.limit, 10) : 100;
      const topics = await mqttDbService.getTopics({
        limit,
        messageType: request.query.messageType,
        hasSchema: request.query.hasSchema ? request.query.hasSchema === 'true' : undefined
      });

      return reply.send({ success: true, count: topics.length, data: topics });
    } catch (error: any) {
      logger.error('Error getting database topics', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get('/database/stats/summary', async (_request, reply) => {
    try {
      const mqttDbService = getBrokerDbService();
      if (!mqttDbService) {
        return reply.status(400).send({ success: false, error: 'Database persistence not enabled' });
      }

      return reply.send({ success: true, data: await mqttDbService.getStatsSummary() });
    } catch (error: any) {
      logger.error('Error getting stats summary', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get<{ Params: TopicParams }>('/database/schema-history/:topic', async (request, reply) => {
    try {
      const mqttDbService = getBrokerDbService();
      if (!mqttDbService) {
        return reply.status(400).send({ success: false, error: 'Database persistence not enabled' });
      }

      const topic = decodeTopicParam(request.params.topic);
      const history = await mqttDbService.getSchemaHistory(topic);
      return reply.send({ success: true, topic, count: history.length, data: history });
    } catch (error: any) {
      logger.error('Error getting schema history', { error: error.message, topic: request.params.topic });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get<{ Querystring: TopicActivityQuerystring }>('/recent-activity', async (request, reply) => {
    try {
      const mqttDbService = getBrokerDbService();
      if (!mqttDbService) {
        return reply.status(400).send({ success: false, error: 'Database persistence not enabled' });
      }

      const windowMinutes = request.query.window ? parseInt(request.query.window, 10) : 15;
      if (![5, 15, 30, 60].includes(windowMinutes)) {
        return reply.status(400).send({ success: false, error: 'Invalid window parameter. Must be one of: 5, 15, 30, 60' });
      }

      const recentActivity = await mqttDbService.getRecentMessageCounts(windowMinutes);
      return reply.send({ success: true, windowMinutes, count: recentActivity.length, data: recentActivity });
    } catch (error: any) {
      logger.error('Error getting recent activity', { error: error.message });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get<{ Params: TopicIdParams; Querystring: TopicActivityQuerystring }>('/topics/by-id/:topicId/recent-activity', async (request, reply) => {
    try {
      const mqttDbService = getBrokerDbService();
      if (!mqttDbService) {
        return reply.status(400).send({ success: false, error: 'Database persistence not enabled' });
      }

      const { topicId } = request.params;
      const windowMinutes = request.query.window ? parseInt(request.query.window, 10) : 15;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(topicId)) {
        return reply.status(400).send({ success: false, error: 'Invalid topic_id format' });
      }

      const activity = await mqttDbService.getTopicRecentActivity(topicId, windowMinutes);
      if (!activity) {
        return reply.status(404).send({ success: false, error: 'No recent activity found for this topic' });
      }

      return reply.send({ success: true, data: activity });
    } catch (error: any) {
      logger.error('Error getting topic recent activity by ID', { error: error.message, topicId: request.params.topicId });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });

  fastify.get<{ Params: TopicParams; Querystring: TopicActivityQuerystring }>('/topics/:topic/recent-activity', async (request, reply) => {
    try {
      const mqttDbService = getBrokerDbService();
      if (!mqttDbService) {
        return reply.status(400).send({ success: false, error: 'Database persistence not enabled' });
      }

      const topic = decodeTopicParam(request.params.topic);
      const windowMinutes = request.query.window ? parseInt(request.query.window, 10) : 15;
      const activity = await mqttDbService.getTopicRecentActivity(topic, windowMinutes);
      if (!activity) {
        return reply.status(404).send({ success: false, error: 'No recent activity found for this topic' });
      }

      return reply.send({ success: true, data: activity });
    } catch (error: any) {
      logger.error('Error getting topic recent activity', { error: error.message, topic: request.params.topic });
      return reply.status(500).send({ success: false, error: error.message });
    }
  });
};

export default plugin;
