/**
 * Audit Page Type Definitions
 * Unified audit event model for all platform events
 */

export type AuditCategory = 'device' | 'user' | 'system' | 'mqtt' | 'security' | 'billing';
export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface AuditEvent {
  id: string;
  event_id: string;
  timestamp: string;
  category: AuditCategory;
  type: string;              // e.g., device.deployed, user.login
  severity: AuditSeverity;
  title: string;
  description: string;
  entity_type: string;       // device, user, namespace, mqtt_client
  entity_id: string;
  entity_name?: string;
  actor_id?: string;         // Who performed the action
  actor_name?: string;
  data: Record<string, any>;
  metadata: Record<string, any>;
}

export interface AuditFilters {
  dateRange: {
    start: Date | null;
    end: Date | null;
  };
  categories: AuditCategory[];
  eventTypes: string[];
  severity: AuditSeverity[];
  entitySearch: string;
  actorSearch: string;
}

export interface AuditStats {
  totalEvents: number;
  errorCount: number;
  warningCount: number;
  categoryBreakdown: Record<AuditCategory, number>;
  recentActivityTrend: Array<{ timestamp: string; count: number }>;
}
