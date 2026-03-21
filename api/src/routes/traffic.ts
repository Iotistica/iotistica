// Device Traffic Statistics Routes
import express from 'express';
import { logger } from '../utils/logger';
export const router = express.Router();
import { 
  getTrafficStats, 
  getDeviceTrafficStats, 
  getAggregatedDeviceStats 
} from "../middleware/traffic-logger";


// ============================================================================
// Traffic Statistics Endpoints
// ============================================================================

/**
 * Get all device traffic statistics (detailed by endpoint)
 * GET /api/v1/traffic-stats
 */
router.get("/traffic-stats", async (req, res) => {
  res.json(getTrafficStats());
});

/**
 * Get aggregated traffic statistics per device (summary)
 * GET /api/v1/traffic-stats/agents
 */
router.get("/traffic-stats/agents", async (req, res) => {
  res.json(getAggregatedDeviceStats());
});

/**
 * Get traffic statistics for a specific device
 * GET /api/v1/traffic-stats/agents/:uuid
 */
router.get("/traffic-stats/agents/:uuid", async (req, res) => {
  const deviceUuid = req.params.uuid;
  const stats = getDeviceTrafficStats(deviceUuid);
  
  if (stats.length === 0) {
    res.status(404).json({
      error: 'Not Found',
      message: `No traffic statistics found for device ${deviceUuid}`
    });
    return;
  }

  // Calculate aggregated totals
  const totalRequests = stats.reduce((sum, s) => sum + s.count, 0);
  const totalBytes = stats.reduce((sum, s) => sum + s.totalBytes, 0);
  const totalTime = stats.reduce((sum, s) => sum + s.totalTime, 0);
  const totalSuccess = stats.reduce((sum, s) => sum + s.success, 0);
  const totalFailed = stats.reduce((sum, s) => sum + s.failed, 0);

  res.json({
    deviceId: deviceUuid,
    summary: {
      totalRequests,
      totalBytes,
      avgResponseTime: totalRequests > 0 ? totalTime / totalRequests : 0,
      successRate: totalRequests > 0 ? (totalSuccess / totalRequests) * 100 : 0,
      totalSuccess,
      totalFailed,
      endpointCount: stats.length
    },
    endpoints: stats
  });
});

/**
 * Get MQTT traffic statistics (incoming messages per topic)
 * GET /api/v1/traffic-stats/mqtt
 * Query params:
 *   - limit: Number of topics to return (default: 20)
 *   - sortBy: Sort field - 'messageCount', 'bytesReceived', 'avgMessageSize' (default: 'bytesReceived')
 */
router.get("/traffic-stats/mqtt", async (req, res) => {
  try {
    const { query } = await import('../db/connection');
    
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const sortBy = req.query.sortBy as string || 'bytes_received';
    
    // Validate sortBy parameter
    const validSortFields = ['message_count', 'bytes_received', 'avg_message_size'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'bytes_received';
    
    // Aggregate MQTT topic metrics from the last 24 hours
    const result = await query(`
      SELECT 
        topic,
        SUM(message_count) as message_count,
        SUM(bytes_received) as bytes_received,
        AVG(avg_message_size)::INTEGER as avg_message_size,
        MAX(timestamp) as last_activity
      FROM mqtt_topic_metrics
      WHERE timestamp > NOW() - INTERVAL '24 hours'
      GROUP BY topic
      ORDER BY ${sortField} DESC
      LIMIT $1
    `, [limit]);
    
    // Calculate totals
    const totalMessages = result.rows.reduce((sum: number, row: any) => sum + parseInt(row.message_count || 0), 0);
    const totalBytes = result.rows.reduce((sum: number, row: any) => sum + parseInt(row.bytes_received || 0), 0);
    
    res.json({
      success: true,
      timeWindow: '24h',
      summary: {
        totalTopics: result.rows.length,
        totalMessages,
        totalBytes,
        avgMessageSize: totalMessages > 0 ? Math.round(totalBytes / totalMessages) : 0
      },
      topics: result.rows.map((row: any) => ({
        topic: row.topic,
        messageCount: parseInt(row.message_count || 0),
        bytesReceived: parseInt(row.bytes_received || 0),
        avgMessageSize: parseInt(row.avg_message_size || 0),
        lastActivity: row.last_activity
      }))
    });
  } catch (error: any) {
    logger.error('Error fetching MQTT traffic stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch MQTT traffic statistics',
      message: error.message
    });
  }
});

