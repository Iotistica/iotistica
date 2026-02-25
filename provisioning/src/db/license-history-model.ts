/**
 * License History Model
 * Tracks license generation, plan changes, and usage for audit/compliance
 * 
 * NOTE: This stores METADATA about licenses, NOT the actual JWT tokens
 */

import { query } from './connection';

export interface LicenseHistoryEntry {
  id: number;
  customer_id: string;
  action: 'generated' | 'regenerated' | 'upgraded' | 'downgraded' | 'revoked';
  plan: string;
  max_devices: number;
  generated_at: Date;
  generated_by: string;
  license_hash: string;  // SHA-256 hash of JWT (NOT the actual JWT)
  metadata?: any;
}

export class LicenseHistoryModel {
  /**
   * Log a license generation event
   */
  static async log(data: {
    customerId: string;
    action: 'generated' | 'regenerated' | 'upgraded' | 'downgraded' | 'revoked';
    plan: string;
    maxDevices: number;
    licenseHash: string;
    generatedBy?: string;
    metadata?: any;
  }): Promise<LicenseHistoryEntry> {
    const result = await query<LicenseHistoryEntry>(
      `INSERT INTO license_history 
       (customer_id, action, plan, max_devices, license_hash, generated_by, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.customerId,
        data.action,
        data.plan,
        data.maxDevices,
        data.licenseHash,
        data.generatedBy || 'system',
        data.metadata ? JSON.stringify(data.metadata) : null
      ]
    );

    return result.rows[0];
  }

  /**
   * Get license history for a customer
   */
  static async getByCustomerId(
    customerId: string, 
    limit: number = 100
  ): Promise<LicenseHistoryEntry[]> {
    const result = await query<LicenseHistoryEntry>(
      `SELECT * FROM license_history 
       WHERE customer_id = $1 
       ORDER BY generated_at DESC 
       LIMIT $2`,
      [customerId, limit]
    );

    return result.rows;
  }

  /**
   * Get recent license generations across all customers
   */
  static async getRecent(limit: number = 50): Promise<LicenseHistoryEntry[]> {
    const result = await query<LicenseHistoryEntry>(
      `SELECT lh.*, c.email, c.company_name
       FROM license_history lh
       JOIN customers c ON lh.customer_id = c.customer_id
       ORDER BY lh.generated_at DESC 
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  }

  /**
   * Get license generations by action type
   */
  static async getByAction(
    action: string, 
    limit: number = 100
  ): Promise<LicenseHistoryEntry[]> {
    const result = await query<LicenseHistoryEntry>(
      `SELECT lh.*, c.email, c.company_name
       FROM license_history lh
       JOIN customers c ON lh.customer_id = c.customer_id
       WHERE lh.action = $1 
       ORDER BY lh.generated_at DESC 
       LIMIT $2`,
      [action, limit]
    );

    return result.rows;
  }

  /**
   * Get statistics on license generation
   */
  static async getStats(customerId?: string): Promise<{
    totalGenerations: number;
    byAction: Record<string, number>;
    byPlan: Record<string, number>;
  }> {
    const whereClause = customerId ? 'WHERE customer_id = $1' : '';
    const params = customerId ? [customerId] : [];

    const totalResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM license_history ${whereClause}`,
      params
    );

    const byActionResult = await query<{ action: string; count: string }>(
      `SELECT action, COUNT(*) as count 
       FROM license_history ${whereClause}
       GROUP BY action`,
      params
    );

    const byPlanResult = await query<{ plan: string; count: string }>(
      `SELECT plan, COUNT(*) as count 
       FROM license_history ${whereClause}
       GROUP BY plan`,
      params
    );

    return {
      totalGenerations: parseInt(totalResult.rows[0].count),
      byAction: byActionResult.rows.reduce((acc, row) => {
        acc[row.action] = parseInt(row.count);
        return acc;
      }, {} as Record<string, number>),
      byPlan: byPlanResult.rows.reduce((acc, row) => {
        acc[row.plan] = parseInt(row.count);
        return acc;
      }, {} as Record<string, number>),
    };
  }

  /**
   * Verify if a license hash exists (for debugging)
   */
  static async verifyHash(licenseHash: string): Promise<LicenseHistoryEntry | null> {
    const result = await query<LicenseHistoryEntry>(
      `SELECT lh.*, c.email, c.company_name
       FROM license_history lh
       JOIN customers c ON lh.customer_id = c.customer_id
       WHERE lh.license_hash = $1 
       ORDER BY lh.generated_at DESC 
       LIMIT 1`,
      [licenseHash]
    );

    return result.rows[0] || null;
  }
}
