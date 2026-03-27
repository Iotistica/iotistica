/**
 * Audit Logger - Structured logging for security events
 * Logs to both file and database for compliance and monitoring
 */

import winston from 'winston';
import { query } from '../db/connection';

// Detect Kubernetes environment (KUBERNETES_SERVICE_HOST is auto-injected)
const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;

// Winston logger configuration
export const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'Iotistic-api' },
  transports: [
    // Console output (always enabled, required for Kubernetes)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Add file transports only if NOT in Kubernetes
if (!isKubernetes) {
  auditLogger.add(new winston.transports.File({ 
    filename: 'logs/audit.log',
    maxsize: 10485760, // 10MB
    maxFiles: 10,
    tailable: true
  }));
  auditLogger.add(new winston.transports.File({ 
    filename: 'logs/error.log', 
    level: 'error',
    maxsize: 10485760,
    maxFiles: 5
  }));
}

// Severity levels
export enum AuditSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical'
}

// Common event types
export enum AuditEventType {
  // Provisioning events
  PROVISIONING_STARTED = 'provisioning_started',
  PROVISIONING_SUCCESS = 'provisioning_success',
  PROVISIONING_FAILED = 'provisioning_failed',
  PROVISIONING_KEY_INVALID = 'provisioning_key_invalid',
  PROVISIONING_KEY_EXPIRED = 'provisioning_key_expired',
  PROVISIONING_LIMIT_EXCEEDED = 'provisioning_limit_exceeded',
  
  // Authentication events
  DEVICE_AUTHENTICATED = 'device_authenticated',
  AUTHENTICATION_FAILED = 'authentication_failed',
  KEY_EXCHANGE_SUCCESS = 'key_exchange_success',
  KEY_EXCHANGE_FAILED = 'key_exchange_failed',
  
  // Device lifecycle
  DEVICE_REGISTERED = 'device_registered',
  DEVICE_ONLINE = 'device_online',
  DEVICE_OFFLINE = 'device_offline',
  DEVICE_CONFIG_UPDATE = 'device_config_update',
  
  // Key management
  API_KEY_CREATED = 'api_key_created',
  API_KEY_ROTATED = 'api_key_rotated',
  API_KEY_REVOKED = 'api_key_revoked',
  
  // Security events
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  UNAUTHORIZED_ACCESS = 'unauthorized_access',
  
  // Digital Twin events
  DEVICE_TWIN_ACCESSED = 'device_twin_accessed',
  FLEET_TWIN_ACCESSED = 'fleet_twin_accessed',
  FLEET_HEALTH_ACCESSED = 'fleet_health_accessed',
  FLEET_ALERTS_ACCESSED = 'fleet_alerts_accessed',
  
  // Digital Twin History events (Phase 4)
  DEVICE_TWIN_HISTORY_ACCESSED = 'device_twin_history_accessed',
  DEVICE_TWIN_ANOMALIES_ACCESSED = 'device_twin_anomalies_accessed'
}

export interface AuditLogEntry {
  eventType: AuditEventType | string;
  agentUuid?: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  details?: any;
  severity?: AuditSeverity;
}

/**
 * Log an audit event to both Winston and database
 */
export async function logAuditEvent(entry: AuditLogEntry): Promise<void> {
  const {
    eventType,
    agentUuid,
    userId,
    ipAddress,
    userAgent,
    details,
    severity = AuditSeverity.INFO
  } = entry;

  // Log to Winston
  const logData = {
    event: eventType,
    deviceUuid: agentUuid ? `${agentUuid.substring(0, 8)}...` : undefined,
    userId,
    ipAddress,
    severity,
    ...details
  };

  switch (severity) {
    case AuditSeverity.CRITICAL:
    case AuditSeverity.ERROR:
      auditLogger.error(eventType, logData);
      break;
    case AuditSeverity.WARNING:
      auditLogger.warn(eventType, logData);
      break;
    default:
      auditLogger.info(eventType, logData);
  }

  // Log to database
  try {
    await query(
      `INSERT INTO audit_logs (event_type, agent_uuid, user_id, ip_address, user_agent, details, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        eventType,
        agentUuid || null,
        userId || null,
        ipAddress || null,
        userAgent || null,
        details ? JSON.stringify(details) : null,
        severity
      ]
    );
  } catch (error) {
    // Don't fail the request if audit logging fails, but log the error
    auditLogger.error('Failed to write audit log to database', {
      error: error instanceof Error ? error.message : String(error),
      eventType,
      deviceUuid: agentUuid ? `${agentUuid.substring(0, 8)}...` : undefined
    });
  }
}

/**
 * Log provisioning attempt (for rate limiting and abuse detection)
 */
export async function logProvisioningAttempt(
  ipAddress: string,
  deviceUuid: string | null,
  provisioningKeyId: string | null,
  success: boolean,
  errorMessage?: string,
  userAgent?: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO provisioning_attempts (ip_address, agent_uuid, provisioning_key_id, success, error_message, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ipAddress, deviceUuid, provisioningKeyId, success, errorMessage || null, userAgent || null]
    );
  } catch (error) {
    auditLogger.error('Failed to log provisioning attempt', {
      error: error instanceof Error ? error.message : String(error),
      ipAddress,
      deviceUuid,
      success
    });
  }
}

/**
 * Check if IP has exceeded provisioning rate limit
 */
export async function checkProvisioningRateLimit(ipAddress: string): Promise<void> {
  const result = await query(
    `SELECT COUNT(*) as attempt_count
     FROM provisioning_attempts
     WHERE ip_address = $1
     AND success = false
     AND created_at > NOW() - INTERVAL '1 hour'`,
    [ipAddress]
  );

  const attemptCount = parseInt(result.rows[0].attempt_count);
  const maxAttempts = process.env.NODE_ENV === 'development' ? 100 : 10; // Relaxed for dev

  if (attemptCount > maxAttempts) {
    await logAuditEvent({
      eventType: AuditEventType.RATE_LIMIT_EXCEEDED,
      ipAddress,
      severity: AuditSeverity.WARNING,
      details: { attemptCount, window: '1 hour', maxAttempts }
    });
    throw new Error('Too many failed provisioning attempts. IP temporarily blocked.');
  }
}

export default {
  auditLogger,
  logAuditEvent,
  logProvisioningAttempt,
  checkProvisioningRateLimit,
  AuditSeverity,
  AuditEventType
};
