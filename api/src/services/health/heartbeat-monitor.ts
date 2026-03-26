/**
 * Heartbeat Monitor Service
 * Monitors device connectivity and marks agents offline when they stop communicating
 * 
 * IMPORTANT: Handles API downtime gracefully
 * - Tracks last check time in database
 * - On restart, only marks agents offline if they were inactive BEFORE API stopped
 * - Prevents false offline detections during API maintenance/crashes
 */

import { query } from '../../db/connection';
import { logAuditEvent, AuditEventType, AuditSeverity } from '../../utils/audit-logger';
import { EventPublisher } from './../event-sourcing';
import logger from '../../utils/logger';

const HEARTBEAT_STATE_KEY = 'heartbeat_last_check';

export class HeartbeatMonitor {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly checkInterval: number;
  private readonly offlineThreshold: number;
  private readonly enabled: boolean;
  private lastCheckTime: Date | null = null;
  private apiStartTime: Date;
  private eventPublisher: EventPublisher;

  constructor() {
    // Configuration from environment variables
    this.checkInterval = parseInt(process.env.HEARTBEAT_CHECK_INTERVAL || '60000'); // 1 minute default
    this.offlineThreshold = parseInt(process.env.HEARTBEAT_OFFLINE_THRESHOLD || '5'); // 5 minutes default
    this.enabled = process.env.HEARTBEAT_ENABLED !== 'false'; // Enabled by default
    this.apiStartTime = new Date();
    
    // Initialize event publisher for connectivity events
    this.eventPublisher = new EventPublisher('heartbeat_monitor');
  }

  /**
   * Start the heartbeat monitor
   */
  async start(): Promise<void> {
    if (!this.enabled) {
       logger.info('🫀 Heartbeat monitor disabled via configuration');
      return;
    }

     logger.info('Starting heartbeat monitor...');
     logger.info(`   Check interval: ${this.checkInterval / 1000}s`);
     logger.info(`   Offline threshold: ${this.offlineThreshold} minutes`);

    // Load last check time from database
    await this.loadLastCheckTime();

    // Check if API was down and handle accordingly
    await this.handleApiRestart();

    // Run first check
    await this.checkDevices();

    // Then run at regular intervals
    this.intervalId = setInterval(() => {
      this.checkDevices();
    }, this.checkInterval);
  }

  /**
   * Stop the heartbeat monitor
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      
      // Save last check time before stopping
      this.saveLastCheckTime().catch(err => {
         logger.error('Failed to save last check time:', err.message);
      });
      
       logger.info('🫀 Heartbeat monitor stopped');
    }
  }

  /**
   * Load last check time from database
   * Note: system_config table must exist (created by migration 002_add_system_config.sql)
   */
  private async loadLastCheckTime(): Promise<void> {
    try {
      const result = await query<{value: {timestamp: string}}>(
        'SELECT value FROM system_config WHERE key = $1',
        [HEARTBEAT_STATE_KEY]
      );

      if (result.rows.length > 0) {
        this.lastCheckTime = new Date(result.rows[0].value.timestamp);
         logger.info(`   Last check was at: ${this.lastCheckTime.toISOString()}`);
      } else {
         logger.info('   No previous check time found (first run)');
      }
    } catch (error: any) {
       logger.warn('  Could not load last check time:', error.message);
       logger.warn('   Make sure to run database migrations: npx ts-node scripts/run-migrations.ts');
      this.lastCheckTime = null;
    }
  }

  /**
   * Save last check time to database
   */
  private async saveLastCheckTime(): Promise<void> {
    try {
      const now = new Date();
      await query(
        `INSERT INTO system_config (key, value, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET
           value = $2,
           updated_at = $3`,
        [
          HEARTBEAT_STATE_KEY,
          JSON.stringify({ timestamp: now.toISOString() }),
          now
        ]
      );
      this.lastCheckTime = now;
    } catch (error: any) {
       logger.error(' Failed to save last check time:', error.message);
    }
  }

  /**
   * Handle API restart - check if we were down and adjust accordingly
   */
  private async handleApiRestart(): Promise<void> {
    if (!this.lastCheckTime) {
       logger.info('   First run - no previous state to recover');
      return;
    }

    const now = new Date();
    const apiDowntimeMs = now.getTime() - this.lastCheckTime.getTime();
    const apiDowntimeMinutes = Math.floor(apiDowntimeMs / 60000);

    if (apiDowntimeMs > this.checkInterval * 2) {
      // API was down for more than 2 check intervals
       logger.info(`  API downtime detected: ${apiDowntimeMinutes} minutes`);
       logger.info(`   Last check: ${this.lastCheckTime.toISOString()}`);
       logger.info(`   API restarted: ${now.toISOString()}`);
      
      // Calculate the cutoff time: agents must have been inactive BEFORE API stopped
      // to be marked offline now
      const safeOfflineThreshold = this.offlineThreshold + apiDowntimeMinutes;
      
       logger.info(`   Adjusted offline threshold: ${safeOfflineThreshold} minutes (includes downtime)`);
      
      // Mark agents offline only if they were inactive before API went down
      const result = await query(`
        UPDATE agents 
        SET is_online = false,
            status = 'offline'
        WHERE is_online = true 
          AND last_connectivity_event < $1
        RETURNING uuid, device_name, last_connectivity_event
      `, [this.lastCheckTime]);

      if (result.rows.length > 0) {
         logger.info(`    Marked ${result.rows.length} device(s) offline (were inactive BEFORE API downtime):`);
        
        for (const device of result.rows) {
          const deviceDisplay = device.device_name || device.uuid.substring(0, 8) + '...';
          const lastSeen = device.last_connectivity_event ? 
            new Date(device.last_connectivity_event).toISOString() : 'never';
          
           logger.info(`      - ${deviceDisplay} (last seen: ${lastSeen})`);
          
          //  EVENT SOURCING: Publish device offline event
          await this.eventPublisher.publish(
            'device.offline',
            'agent',
            device.uuid,
            {
              device_name: device.device_name,
              last_seen: device.last_connectivity_event,
              offline_threshold_minutes: this.offlineThreshold,
              detected_at: now.toISOString(),
              reason: 'No heartbeat received - detected after API restart',
              api_downtime_minutes: apiDowntimeMinutes
            },
            {
              metadata: {
                detection_method: 'heartbeat_monitor',
                api_restart: true
              },
              severity: 'warning',
              impact: 'medium',
              actor: {
                type: 'system',
                id: 'heartbeat-monitor',
                name: 'Heartbeat Monitor Service'
              }
            }
          );
          
          await logAuditEvent({
            eventType: AuditEventType.DEVICE_OFFLINE,
            deviceUuid: device.uuid,
            severity: AuditSeverity.WARNING,
            details: {
              deviceName: device.device_name,
              lastSeen: device.last_connectivity_event,
              offlineThresholdMinutes: this.offlineThreshold,
              detectedAt: now.toISOString(),
              apiDowntimeMinutes,
              reason: 'Detected after API restart - device was inactive before downtime'
            }
          });
        }
      } else {
         logger.info('    No agents to mark offline (all were active during API downtime)');
      }
      
      await logAuditEvent({
        eventType: 'api_restart' as AuditEventType,
        severity: AuditSeverity.INFO,
        details: {
          apiDowntimeMinutes,
          lastCheckTime: this.lastCheckTime.toISOString(),
          restartTime: now.toISOString(),
          agentsMarkedOffline: result.rows.length
        }
      });
    } else {
       logger.info('    Normal operation - no significant downtime detected');
    }
  }

  /**
   * Check all agents and mark offline those that haven't communicated
   */
  private async checkDevices(): Promise<void> {
    try {
      // Update agents that haven't communicated within threshold
      const result = await query(`
        UPDATE agents 
        SET is_online = false,
            status = 'offline'
        WHERE is_online = true 
          AND last_connectivity_event < NOW() - INTERVAL '${this.offlineThreshold} minutes'
        RETURNING uuid, device_name, last_connectivity_event
      `);

      if (result.rows.length > 0) {
         logger.info(`  Marked ${result.rows.length} device(s) as offline:`);
        
        for (const device of result.rows) {
          const deviceDisplay = device.device_name || device.uuid.substring(0, 8) + '...';
          const lastSeen = device.last_connectivity_event ? 
            new Date(device.last_connectivity_event).toISOString() : 'never';
          
           logger.info(`   - ${deviceDisplay} (last seen: ${lastSeen})`);
          
          //  EVENT SOURCING: Publish device offline event
          await this.eventPublisher.publish(
            'device.offline',
            'agent',
            device.uuid,
            {
              device_name: device.device_name,
              last_seen: device.last_connectivity_event,
              offline_threshold_minutes: this.offlineThreshold,
              detected_at: new Date().toISOString(),
              reason: 'No heartbeat received - exceeded threshold'
            },
            {
              metadata: {
                detection_method: 'heartbeat_monitor',
                check_interval_ms: this.checkInterval
              },
              severity: 'warning',
              impact: 'medium',
              actor: {
                type: 'system',
                id: 'heartbeat-monitor',
                name: 'Heartbeat Monitor Service'
              }
            }
          );
          
          // Log to audit trail
          await logAuditEvent({
            eventType: AuditEventType.DEVICE_OFFLINE,
            deviceUuid: device.uuid,
            severity: AuditSeverity.WARNING,
            details: {
              deviceName: device.device_name,
              lastSeen: device.last_connectivity_event,
              offlineThresholdMinutes: this.offlineThreshold,
              detectedAt: new Date().toISOString()
            }
          });
        }
      }

      // Save this check time for recovery after restart
      await this.saveLastCheckTime();
      
    } catch (error: any) {
       logger.error(' Error checking device heartbeats:', error.message);
    }
  }

  /**
   * Manually trigger a heartbeat check (useful for testing)
   */
  async checkNow(): Promise<void> {
    await this.checkDevices();
  }

  /**
   * Get current configuration
   */
  getConfig() {
    return {
      enabled: this.enabled,
      checkInterval: this.checkInterval,
      offlineThreshold: this.offlineThreshold,
      isRunning: this.intervalId !== null
    };
  }
}

// Export singleton instance
export default new HeartbeatMonitor();
