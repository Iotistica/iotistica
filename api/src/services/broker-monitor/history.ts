/**
 * Stats History Service
 * Stores recent MQTT stats in memory for chart visualization
 */

export interface StatsHistoryPoint {
  timestamp: string;
  clients: number;
  subscriptions: number;
  messageRate: {
    published: number;
    received: number;
  };
  throughput: {
    inbound: number;
    outbound: number;
  };
}

export class StatsHistoryService {
  private history: StatsHistoryPoint[] = [];
  private maxPoints: number = 30; // Keep last 30 data points (5 minutes at 10s intervals)
  private updateInterval: NodeJS.Timeout | null = null;
  private getStatsCallback: (() => any) | null = null;

  constructor(maxPoints: number = 30) {
    this.maxPoints = maxPoints;
  }

  /**
   * Start periodic stats collection
   * @param getStats - Function that returns current stats
   * @param intervalMs - Collection interval in milliseconds (default: 10000 = 10s)
   */
  start(getStats: () => any, intervalMs: number = 10000) {
    this.getStatsCallback = getStats;

    // Store first point immediately
    this.recordCurrentStats();

    // Then collect periodically
    this.updateInterval = setInterval(() => {
      this.recordCurrentStats();
    }, intervalMs);
  }

  /**
   * Stop periodic collection
   */
  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Record current stats to history
   */
  private recordCurrentStats() {
    if (!this.getStatsCallback) return;

    try {
      const stats = this.getStatsCallback();

      const point: StatsHistoryPoint = {
        timestamp: new Date().toISOString(),
        clients: stats.clients || 0,
        subscriptions: stats.subscriptions || 0,
        messageRate: {
          published: stats.messageRate?.published || 0,
          received: stats.messageRate?.received || 0
        },
        throughput: {
          inbound: stats.throughput?.inbound || 0,
          outbound: stats.throughput?.outbound || 0
        }
      };

      this.history.push(point);

      // Keep only last N points (ring buffer)
      if (this.history.length > this.maxPoints) {
        this.history.shift();
      }
    } catch {
      // Swallow errors - history recording is best-effort
    }
  }

  /**
   * Get history data
   * @param limit - Optional limit on number of points returned
   */
  getHistory(limit?: number): StatsHistoryPoint[] {
    if (limit && limit < this.history.length) {
      return this.history.slice(-limit);
    }
    return [...this.history];
  }

  /**
   * Clear history
   */
  clear() {
    this.history = [];
  }
}
