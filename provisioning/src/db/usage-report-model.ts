/**
 * Usage Report Model
 */

import { query } from './connection';

export interface UsageReport {
  id: number;
  customer_id: string;
  instance_id: string;
  active_devices: number;
  total_devices: number;
  reported_at: Date;
}

export class UsageReportModel {
  /**
   * Create usage report
   */
  static async create(data: {
    customer_id: string;
    instance_id: string;
    active_devices: number;
    total_devices: number;
  }): Promise<UsageReport> {
    const result = await query<UsageReport>(
      `INSERT INTO usage_reports (
        customer_id, instance_id, active_devices, total_devices, reported_at
      ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        data.customer_id,
        data.instance_id,
        data.active_devices,
        data.total_devices,
      ]
    );

    return result.rows[0];
  }

  /**
   * Get usage history for customer
   */
  static async getByCustomerId(
    customerId: string,
    limit: number = 100
  ): Promise<UsageReport[]> {
    const result = await query<UsageReport>(
      `SELECT * FROM usage_reports 
       WHERE customer_id = $1 
       ORDER BY reported_at DESC 
       LIMIT $2`,
      [customerId, limit]
    );
    return result.rows;
  }

  /**
   * Get latest usage for customer
   */
  static async getLatest(customerId: string): Promise<UsageReport | null> {
    const result = await query<UsageReport>(
      `SELECT * FROM usage_reports 
       WHERE customer_id = $1 
       ORDER BY reported_at DESC 
       LIMIT 1`,
      [customerId]
    );
    return result.rows[0] || null;
  }

  /**
   * Clean old usage reports (keep last 90 days)
   */
  static async cleanup(daysToKeep: number = 90): Promise<number> {
    const result = await query(
      `DELETE FROM usage_reports 
       WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'`
    );
    return result.rowCount || 0;
  }
}
