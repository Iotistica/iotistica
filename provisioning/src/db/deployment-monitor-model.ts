/**
 * Deployment Monitor Model
 * Tracks continuous Argo CD status for a customer deployment
 */

import { query } from './connection';

export interface DeploymentMonitor {
  id?: number;
  customer_id: string;
  client_id: string;
  namespace: string;
  health_status?: string;
  sync_status?: string;
  operation_phase?: string;
  last_polled_at?: Date;
  polling_stopped_at?: Date | null;
  monitor_job_id?: string;
  status_message?: string;
  poll_count?: number;
  degraded_count?: number;
  monitoring_started_at?: Date;
  ready_at?: Date | null;
  stopped_reason?: string;
  created_at?: Date;
  updated_at?: Date;
}

export class DeploymentMonitorModel {
  /**
   * Create or initialize monitoring record for a customer
   */
  static async initialize(data: {
    customer_id: string;
    client_id: string;
    namespace: string;
    monitor_job_id?: string;
  }): Promise<DeploymentMonitor> {
    const result = await query<DeploymentMonitor>(
      `INSERT INTO deployment_monitor (customer_id, client_id, namespace, monitor_job_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (customer_id) 
       DO UPDATE SET 
         monitor_job_id = $4,
         last_polled_at = CURRENT_TIMESTAMP,
         polling_stopped_at = NULL,
         poll_count = 0,
         degraded_count = 0,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [data.customer_id, data.client_id, data.namespace, data.monitor_job_id]
    );
    return result.rows[0];
  }

  /**
   * Update status after polling Argo CD
   */
  static async updateStatus(customerId: string, data: {
    health_status: string;
    sync_status: string;
    operation_phase?: string;
    status_message?: string;
  }): Promise<DeploymentMonitor> {
    const result = await query<DeploymentMonitor>(
      `UPDATE deployment_monitor 
       SET health_status = $2,
           sync_status = $3,
           operation_phase = $4,
           status_message = $5,
           poll_count = poll_count + 1,
           degraded_count = CASE 
             WHEN $2 IN ('Degraded', 'Missing') THEN degraded_count + 1 
             ELSE degraded_count 
           END,
           last_polled_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1
       RETURNING *`,
      [customerId, data.health_status, data.sync_status, data.operation_phase, data.status_message]
    );
    return result.rows[0];
  }

  /**
   * Mark app as ready (first time it reached healthy + synced state)
   */
  static async markReady(customerId: string): Promise<DeploymentMonitor> {
    const result = await query<DeploymentMonitor>(
      `UPDATE deployment_monitor 
       SET ready_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1 AND ready_at IS NULL
       RETURNING *`,
      [customerId]
    );
    return result.rows[0];
  }

  /**
   * Stop monitoring with a reason
   */
  static async stopMonitoring(customerId: string, reason: 'healthy' | 'degraded' | 'customer_deleted' | 'manual_stop'): Promise<DeploymentMonitor> {
    const result = await query<DeploymentMonitor>(
      `UPDATE deployment_monitor 
       SET polling_stopped_at = CURRENT_TIMESTAMP,
           stopped_reason = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1
       RETURNING *`,
      [customerId, reason]
    );
    return result.rows[0];
  }

  /**
   * Get current monitoring record
   */
  static async getByCustomerId(customerId: string): Promise<DeploymentMonitor | null> {
    const result = await query<DeploymentMonitor>(
      'SELECT * FROM deployment_monitor WHERE customer_id = $1',
      [customerId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get all active monitoring records (still polling)
   */
  static async getActiveMonitorings(): Promise<DeploymentMonitor[]> {
    const result = await query<DeploymentMonitor>(
      'SELECT * FROM deployment_monitor WHERE polling_stopped_at IS NULL ORDER BY last_polled_at ASC',
      []
    );
    return result.rows;
  }

  /**
   * Check if monitoring is active for customer
   */
  static async isMonitoring(customerId: string): Promise<boolean> {
    const result = await query<{ count: number }>(
      `SELECT COUNT(*) as count FROM deployment_monitor 
       WHERE customer_id = $1 AND polling_stopped_at IS NULL`,
      [customerId]
    );
    return (result.rows[0]?.count || 0) > 0;
  }
}
