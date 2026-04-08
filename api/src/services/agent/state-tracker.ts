/**
 * State Change Tracking Service
 * Industry best practices for tracking container orchestration state changes
 */

import pool from '../../db/connection';
import crypto from 'crypto';

export interface StateSnapshot {
  id: number;
  agent_uuid: string;
  timestamp: Date;
  state_type: 'target' | 'current';
  state: any;
  version: number;
  checksum: string;
  source?: string;
  notes?: string;
}

export interface StateChange {
  id: number;
  agent_uuid: string;
  timestamp: Date;
  state_type: 'target' | 'current';
  change_type: string;
  entity_type?: string;
  entity_id?: string;
  field_path?: string;
  old_value?: any;
  new_value?: any;
  triggered_by: string;
  correlation_id?: string;
  metadata?: any;
}

export interface ReconciliationRecord {
  id: number;
  agent_uuid: string;
  started_at: Date;
  completed_at?: Date;
  status: 'in_progress' | 'success' | 'failed' | 'partial';
  changes_detected: number;
  changes_applied: number;
  changes_failed: number;
  diff?: any;
  actions_taken?: any;
  errors?: any;
  duration_ms?: number;
  correlation_id?: string;
}

export class StateTracker {
  /**
   * Create a state snapshot (full state at a point in time)
   */
  static async createSnapshot(
    deviceUuid: string,
    stateType: 'target' | 'current',
    state: any,
    source: string = 'system',
    notes?: string
  ): Promise<number> {
    const result = await pool.query(
      `SELECT create_state_snapshot($1, $2, $3, $4, $5) as snapshot_id`,
      [deviceUuid, stateType, JSON.stringify(state), source, notes]
    );
    
    return result.rows[0].snapshot_id;
  }

  /**
   * Log a specific state change
   */
  static async logChange(
    deviceUuid: string,
    stateType: 'target' | 'current',
    changeType: string,
    options: {
      entityType?: string;
      entityId?: string;
      fieldPath?: string;
      oldValue?: any;
      newValue?: any;
      triggeredBy: string;
      correlationId?: string;
      metadata?: any;
    }
  ): Promise<number> {
    const result = await pool.query(
      `SELECT log_state_change($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as change_id`,
      [
        deviceUuid,
        stateType,
        changeType,
        options.entityType || null,
        options.entityId || null,
        options.fieldPath || null,
        options.oldValue ? JSON.stringify(options.oldValue) : null,
        options.newValue ? JSON.stringify(options.newValue) : null,
        options.triggeredBy,
        options.correlationId || null,
        options.metadata ? JSON.stringify(options.metadata) : null,
      ]
    );
    
    return result.rows[0].change_id;
  }

  /**
   * Start a reconciliation session
   */
  static async startReconciliation(
    deviceUuid: string,
    targetSnapshotId?: number,
    currentSnapshotId?: number,
    correlationId?: string
  ): Promise<number> {
    const result = await pool.query(
      `INSERT INTO reconciliation_history 
       (agent_uuid, target_snapshot_id, current_snapshot_id, status, correlation_id)
       VALUES ($1, $2, $3, 'in_progress', $4)
       RETURNING id`,
      [deviceUuid, targetSnapshotId || null, currentSnapshotId || null, correlationId || crypto.randomUUID()]
    );
    
    return result.rows[0].id;
  }

  /**
   * Complete a reconciliation session
   */
  static async completeReconciliation(
    reconciliationId: number,
    status: 'success' | 'failed' | 'partial',
    details: {
      changesDetected?: number;
      changesApplied?: number;
      changesFailed?: number;
      diff?: any;
      actionsTaken?: any;
      errors?: any;
      durationMs?: number;
    }
  ): Promise<void> {
    await pool.query(
      `UPDATE reconciliation_history
       SET completed_at = NOW(),
           status = $2,
           changes_detected = $3,
           changes_applied = $4,
           changes_failed = $5,
           diff = $6,
           actions_taken = $7,
           errors = $8,
           duration_ms = $9
       WHERE id = $1`,
      [
        reconciliationId,
        status,
        details.changesDetected || 0,
        details.changesApplied || 0,
        details.changesFailed || 0,
        details.diff ? JSON.stringify(details.diff) : null,
        details.actionsTaken ? JSON.stringify(details.actionsTaken) : null,
        details.errors ? JSON.stringify(details.errors) : null,
        details.durationMs || null,
      ]
    );
  }

  /**
   * Get recent state changes for a device
   */
  static async getRecentChanges(
    deviceUuid: string,
    stateType?: 'target' | 'current',
    limit: number = 50
  ): Promise<StateChange[]> {
    const query = stateType
      ? `SELECT * FROM state_changes WHERE agent_uuid = $1 AND state_type = $2 ORDER BY timestamp DESC LIMIT $3`
      : `SELECT * FROM state_changes WHERE agent_uuid = $1 ORDER BY timestamp DESC LIMIT $2`;
    
    const params = stateType ? [deviceUuid, stateType, limit] : [deviceUuid, limit];
    const result = await pool.query(query, params);
    
    return result.rows;
  }

  /**
   * Get state diff between two versions
   */
  static async getStateDiff(
    deviceUuid: string,
    stateType: 'target' | 'current',
    fromVersion: number,
    toVersion?: number
  ): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM get_state_diff($1, $2, $3, $4)`,
      [deviceUuid, stateType, fromVersion, toVersion || null]
    );
    
    return result.rows;
  }

  /**
   * Get reconciliation history
   */
  static async getReconciliationHistory(
    deviceUuid: string,
    daysBack: number = 7
  ): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM get_reconciliation_summary($1, $2)`,
      [deviceUuid, daysBack]
    );
    
    return result.rows;
  }

  /**
   * Get latest snapshot for a device
   */
  static async getLatestSnapshot(
    deviceUuid: string,
    stateType: 'target' | 'current'
  ): Promise<StateSnapshot | null> {
    const result = await pool.query(
      `SELECT * FROM state_snapshots 
       WHERE agent_uuid = $1 AND state_type = $2
       ORDER BY version DESC LIMIT 1`,
      [deviceUuid, stateType]
    );
    
    return result.rows[0] || null;
  }

  /**
   * Compare target vs current state
   */
  static async compareStates(deviceUuid: string): Promise<{
    target?: StateSnapshot;
    current?: StateSnapshot;
    inSync: boolean;
    drift?: any;
  }> {
    const target = await this.getLatestSnapshot(deviceUuid, 'target');
    const current = await this.getLatestSnapshot(deviceUuid, 'current');
    
    if (!target || !current) {
      return {
        target: target || undefined,
        current: current || undefined,
        inSync: false,
      };
    }
    
    const inSync = target.checksum === current.checksum;
    
    return {
      target,
      current,
      inSync,
      drift: inSync ? null : this.calculateDrift(target.state, current.state),
    };
  }

  /**
   * Calculate drift between two states (simplified)
   */
  private static calculateDrift(target: any, current: any): any {
    // Simple deep comparison - can be enhanced with better diff algorithm
    const drift: any = {
      added: [],
      removed: [],
      modified: [],
    };

    // Compare apps
    const targetApps = target.apps || {};
    const currentApps = current.apps || {};

    for (const appName in targetApps) {
      if (!(appName in currentApps)) {
        drift.removed.push({ type: 'app', id: appName });
      } else if (JSON.stringify(targetApps[appName]) !== JSON.stringify(currentApps[appName])) {
        drift.modified.push({
          type: 'app',
          id: appName,
          target: targetApps[appName],
          current: currentApps[appName],
        });
      }
    }

    for (const appName in currentApps) {
      if (!(appName in targetApps)) {
        drift.added.push({ type: 'app', id: appName });
      }
    }

    return drift;
  }

  /**
   * Cleanup old history (retention policy)
   */
  static async cleanupOldHistory(retentionDays: number = 90): Promise<{
    snapshotsDeleted: number;
    changesDeleted: number;
    reconciliationsDeleted: number;
  }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const snapshots = await pool.query(
      `DELETE FROM state_snapshots WHERE timestamp < $1 RETURNING id`,
      [cutoffDate]
    );

    const changes = await pool.query(
      `DELETE FROM state_changes WHERE timestamp < $1 RETURNING id`,
      [cutoffDate]
    );

    const reconciliations = await pool.query(
      `DELETE FROM reconciliation_history WHERE started_at < $1 RETURNING id`,
      [cutoffDate]
    );

    return {
      snapshotsDeleted: snapshots.rows.length,
      changesDeleted: changes.rows.length,
      reconciliationsDeleted: reconciliations.rows.length,
    };
  }
}

/**
 * Example Usage in Supervisor:
 * 
 * // When target state changes
 * const correlationId = crypto.randomUUID();
 * await StateTracker.createSnapshot(deviceUuid, 'target', newTargetState, 'api', 'Updated via API');
 * await StateTracker.logChange(deviceUuid, 'target', 'app_updated', {
 *   entityType: 'app',
 *   entityId: 'my-app',
 *   fieldPath: 'apps.my-app.image',
 *   oldValue: 'iotistic/app:v1',
 *   newValue: 'iotistic/app:v2',
 *   triggeredBy: 'api',
 *   correlationId,
 * });
 * 
 * // During reconciliation
 * const reconciliationId = await StateTracker.startReconciliation(deviceUuid);
 * 
 * try {
 *   // ... perform reconciliation ...
 *   
 *   await StateTracker.completeReconciliation(reconciliationId, 'success', {
 *     changesDetected: 5,
 *     changesApplied: 5,
 *     durationMs: 1500,
 *   });
 * } catch (error) {
 *   await StateTracker.completeReconciliation(reconciliationId, 'failed', {
 *     errors: { message: error.message },
 *   });
 * }
 * 
 * // When current state updates
 * await StateTracker.createSnapshot(deviceUuid, 'current', actualState, 'supervisor');
 * 
 * // Query changes
 * const recentChanges = await StateTracker.getRecentChanges(deviceUuid, 'target');
 * const drift = await StateTracker.compareStates(deviceUuid);
 */

export default StateTracker;
