import { Router, Request, Response } from 'express';
import { MQTTMonitorService } from '../services/monitor';
import { MQTTDatabaseService } from '../services/db';
import { StatsHistoryService } from '../services/history';
import { logger } from '../utils/logger';

const router = Router();

let monitor: MQTTMonitorService | null = null;
let mqttDbService: MQTTDatabaseService | null = null;
let historyService: StatsHistoryService | null = null;

export function setMonitorInstance(monitorInstance: MQTTMonitorService | null, dbService: MQTTDatabaseService | null = null, history: StatsHistoryService | null = null) {
  monitor = monitorInstance;
  mqttDbService = dbService;
  historyService = history;
  logger.info('Monitor instance injected into routes');
}

router.get('/status', (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.json({
        success: true,
        data: {
          connected: false,
          message: 'Monitor not initialized'
        }
      });
    }

    const status = monitor.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error: any) {
    logger.error('Error getting status', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.post('/start', async (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.status(400).json({
        success: false,
        error: 'Monitor not initialized'
      });
    }
    
    await monitor.start();
    logger.info('MQTT monitor started via API');
    
    res.json({
      success: true,
      message: 'MQTT monitor started'
    });
  } catch (error: any) {
    logger.error('Error starting monitor', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.post('/stop', async (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.status(400).json({
        success: false,
        error: 'Monitor not running'
      });
    }

    await monitor.stop();
    logger.info('MQTT monitor stopped via API');

    res.json({
      success: true,
      message: 'MQTT monitor stopped'
    });
  } catch (error: any) {
    logger.error('Error stopping monitor', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/topic-tree', (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.status(400).json({
        success: false,
        error: 'Monitor not running'
      });
    }

    const topicTree = monitor.getTopicTree();
    
    res.json({
      success: true,
      data: topicTree
    });
  } catch (error: any) {
    logger.error('Error getting topic tree', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/topics', (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.status(400).json({
        success: false,
        error: 'Monitor not running'
      });
    }

    const timeWindow = req.query.timeWindow as string;
    const minutesParam = req.query.minutes as string;
    
    let filterTimestamp: number | null = null;
    
    if (timeWindow) {
      const now = Date.now();
      switch (timeWindow) {
        case '1h':
          filterTimestamp = now - (60 * 60 * 1000);
          break;
        case '6h':
          filterTimestamp = now - (6 * 60 * 60 * 1000);
          break;
        case '24h':
          filterTimestamp = now - (24 * 60 * 60 * 1000);
          break;
        case '7d':
          filterTimestamp = now - (7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          filterTimestamp = now - (30 * 24 * 60 * 60 * 1000);
          break;
        case 'all':
        default:
          filterTimestamp = null;
          break;
      }
    } else if (minutesParam) {
      const minutes = parseInt(minutesParam, 10);
      if (!isNaN(minutes) && minutes > 0) {
        filterTimestamp = Date.now() - (minutes * 60 * 1000);
      }
    }

    const topics = monitor.getFlattenedTopics(filterTimestamp);
    
    res.json({
      success: true,
      count: topics.length,
      data: topics,
      timeWindow: timeWindow || (minutesParam ? `${minutesParam}m` : 'all'),
      filteredFrom: filterTimestamp ? new Date(filterTimestamp).toISOString() : null
    });
  } catch (error: any) {
    logger.error('Error getting topics', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// UUID-based topic schema endpoint
router.get('/topics/by-id/:topicId/schema', async (req: Request, res: Response) => {
  try {
    if (!mqttDbService) {
      return res.status(400).json({
        success: false,
        error: 'Database persistence not enabled'
      });
    }

    const topicId = req.params.topicId;
    
    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(topicId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid topic_id format'
      });
    }

    const topicRecord = await mqttDbService.getTopicById(topicId);

    if (!topicRecord) {
      return res.status(404).json({
        success: false,
        error: 'Topic not found'
      });
    }

    res.json({
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
    logger.error('Error getting topic schema by ID', { error: error.message, topicId: req.params.topicId });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Legacy topic name-based schema endpoint (backward compatibility)
router.get('/topics/:topic(*)/schema', (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.status(400).json({
        success: false,
        error: 'Monitor not running'
      });
    }

    const topic = req.params.topic;
    const schemaData = monitor.getTopicSchema(topic);

    if (!schemaData) {
      return res.status(404).json({
        success: false,
        error: 'Topic not found or no schema available'
      });
    }

    res.json({
      success: true,
      data: {
        topic,
        ...schemaData
      }
    });
  } catch (error: any) {
    logger.error('Error getting topic schema', { error: error.message, topic: req.params.topic });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/metrics', (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.status(400).json({
        success: false,
        error: 'Monitor not running'
      });
    }

    const metrics = monitor.getMetrics();
    
    res.json({
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
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/system-stats', (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.status(400).json({
        success: false,
        error: 'Monitor not running'
      });
    }

    const systemStats = monitor.getSystemStats();
    
    res.json({
      success: true,
      data: systemStats
    });
  } catch (error: any) {
    logger.error('Error getting system stats', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/stats', (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.status(400).json({
        success: false,
        error: 'Monitor not running'
      });
    }

    const status = monitor.getStatus();
    const metrics = monitor.getMetrics();
    const systemStats = monitor.getSystemStats();
    const topics = monitor.getFlattenedTopics();
    
    const topicsWithSchemas = topics.filter(t => t.schema).length;
    const messageTypeBreakdown = topics.reduce((acc, t) => {
      if (t.messageType) {
        acc[t.messageType] = (acc[t.messageType] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);
    
    res.json({
      success: true,
      stats: {
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
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/stats/history', (req: Request, res: Response) => {
  try {
    if (!historyService) {
      return res.status(404).json({
        success: false,
        error: 'History service not available'
      });
    }

    const limitParam = req.query.limit as string;
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;
    
    const history = historyService.getHistory(limit);
    
    res.json({
      success: true,
      count: history.length,
      history
    });
  } catch (error: any) {
    logger.error('Error getting stats history', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/dashboard', (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.status(400).json({
        success: false,
        error: 'Monitor not running'
      });
    }

    const status = monitor.getStatus();
    const topicTree = monitor.getTopicTree();
    const topics = monitor.getFlattenedTopics();
    const metrics = monitor.getMetrics();
    
    const topicsWithSchemas = topics.filter(t => t.schema).length;
    
    res.json({
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
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.post('/sync', async (req: Request, res: Response) => {
  try {
    if (!monitor) {
      return res.status(400).json({
        success: false,
        error: 'Monitor not running'
      });
    }

    await (monitor as any).flushToDatabase();
    logger.info('Manual database sync triggered');
    
    res.json({
      success: true,
      message: 'Data synced to database'
    });
  } catch (error: any) {
    logger.error('Error syncing to database', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/database/topics', async (req: Request, res: Response) => {
  try {
    if (!mqttDbService) {
      return res.status(400).json({
        success: false,
        error: 'Database persistence not enabled'
      });
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const messageType = req.query.messageType as string;
    const hasSchema = req.query.hasSchema ? req.query.hasSchema === 'true' : undefined;

    const topics = await mqttDbService.getTopics({
      limit,
      messageType,
      hasSchema
    });

    res.json({
      success: true,
      count: topics.length,
      data: topics
    });
  } catch (error: any) {
    logger.error('Error getting database topics', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/database/stats/summary', async (req: Request, res: Response) => {
  try {
    if (!mqttDbService) {
      return res.status(400).json({
        success: false,
        error: 'Database persistence not enabled'
      });
    }

    const summary = await mqttDbService.getStatsSummary();

    res.json({
      success: true,
      data: summary
    });
  } catch (error: any) {
    logger.error('Error getting stats summary', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/database/schema-history/:topic(*)', async (req: Request, res: Response) => {
  try {
    if (!mqttDbService) {
      return res.status(400).json({
        success: false,
        error: 'Database persistence not enabled'
      });
    }

    const topic = req.params.topic;
    const history = await mqttDbService.getSchemaHistory(topic);

    res.json({
      success: true,
      topic,
      count: history.length,
      data: history
    });
  } catch (error: any) {
    logger.error('Error getting schema history', { error: error.message, topic: req.params.topic });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

router.get('/recent-activity', async (req: Request, res: Response) => {
  try {
    if (!mqttDbService) {
      return res.status(400).json({
        success: false,
        error: 'Database persistence not enabled'
      });
    }

    const windowMinutes = req.query.window ? parseInt(req.query.window as string) : 15;
    
    if (![5, 15, 30, 60].includes(windowMinutes)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid window parameter. Must be one of: 5, 15, 30, 60'
      });
    }

    const recentActivity = await mqttDbService.getRecentMessageCounts(windowMinutes);

    res.json({
      success: true,
      windowMinutes,
      count: recentActivity.length,
      data: recentActivity
    });
  } catch (error: any) {
    logger.error('Error getting recent activity', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// UUID-based topic recent activity endpoint
router.get('/topics/by-id/:topicId/recent-activity', async (req: Request, res: Response) => {
  try {
    if (!mqttDbService) {
      return res.status(400).json({
        success: false,
        error: 'Database persistence not enabled'
      });
    }

    const topicId = req.params.topicId;
    const windowMinutes = req.query.window ? parseInt(req.query.window as string) : 15;
    
    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(topicId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid topic_id format'
      });
    }

    const activity = await mqttDbService.getTopicRecentActivity(topicId, windowMinutes);

    if (!activity) {
      return res.status(404).json({
        success: false,
        error: 'No recent activity found for this topic'
      });
    }

    res.json({
      success: true,
      data: activity
    });
  } catch (error: any) {
    logger.error('Error getting topic recent activity by ID', { error: error.message, topicId: req.params.topicId });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Legacy topic name-based recent activity endpoint (backward compatibility)
router.get('/topics/:topic(*)/recent-activity', async (req: Request, res: Response) => {
  try {
    if (!mqttDbService) {
      return res.status(400).json({
        success: false,
        error: 'Database persistence not enabled'
      });
    }

    const topic = req.params.topic;
    const windowMinutes = req.query.window ? parseInt(req.query.window as string) : 15;

    const activity = await mqttDbService.getTopicRecentActivity(topic, windowMinutes);

    if (!activity) {
      return res.status(404).json({
        success: false,
        error: 'No recent activity found for this topic'
      });
    }

    res.json({
      success: true,
      data: activity
    });
  } catch (error: any) {
    logger.error('Error getting topic recent activity', { error: error.message, topic: req.params.topic });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

export default router;
