/**
 * Default Target State Generator
 * 
 * Generates default device target state configuration based on license features.
 * This ensures every device gets proper configuration automatically during provisioning.
 * 
 * License Features → Agent Config Mapping (from billing service):
 * - plan (starter/professional/enterprise) → Different metrics intervals
 * - hasDedicatedPrometheus (billing feature) → enableMetricsExport: true
 * - hasAdvancedAlerts/hasCustomDashboards → enableAdvancedLogging: true (debug level)
 * 
 * Note: enableCloudJobs is always enabled since API access is required for the system to work.
 * 
 * Config Structure:
 * {
 *   "logging": {
 *     "level": "info" | "debug",
 *     "enableRemoteLogging": true
 *   },
 *   "features": {
 *     "enableShadow": true,
 *     "enableCloudJobs": true (always enabled),
 *     "enableMetricsExport": boolean (from hasDedicatedPrometheus)
 *   },
 *   "settings": {
 *     "metricsIntervalMs": number (plan-based: 60s/30s/10s),
 *     "deviceReportIntervalMs": number (plan-based),
 *     "stateReportIntervalMs": number (plan-based)
 *   }
 * }
 */

import logger from '../utils/logger';

interface LicenseData {
  plan: string; // "trial" | "starter" | "professional" | "enterprise"
  features: {
    // Monitoring & observability
    hasDedicatedPrometheus?: boolean;
    hasDedicatedGrafana?: boolean;
    prometheusRetentionDays?: number;
    prometheusStorageGb?: number;
    
    // Job execution capabilities (maps to enableCloudJobs)
    canExecuteJobs?: boolean;
    canScheduleJobs?: boolean;
    
    // Remote access & control
    canRemoteAccess?: boolean;
    canOtaUpdates?: boolean;
    
    // Advanced features (maps to enhanced logging)
    hasAdvancedAlerts?: boolean;
    hasCustomDashboards?: boolean;
    
    // Core device management
    maxDevices?: number;
  };
  limits?: {
    maxJobTemplates?: number;
    maxAlertRules?: number;
    maxUsers?: number;
  };
  trial?: {
    isTrialMode?: boolean;
    expiresAt?: string;
  };
  subscription: {
    status: string; // "active" | "past_due" | "canceled" | "trialing"
    currentPeriodEndsAt?: string;
  };
}

interface TargetStateConfig {
  logging: {
    level: string;
    enableRemoteLogging: boolean;
    enableFilePersistence: boolean;
    enableCompression?: boolean;
  };
  features: {
    enableDeviceJobs: boolean;
    enableDeviceSensorPublish?: boolean;
    enableDeviceRemoteAccess: boolean;
    enableProtocolAdapters?: boolean;
    enableFirstBootDiscovery?: boolean;
    enableAnomalyDetection?: boolean;
  };
  settings: {
    stateReportIntervalMs: number;
    memoryCheckIntervalMs?: number;
    memoryThresholdMb?: number;
    logMaxAge?: number;
    maxLogFileSize?: number;
    maxLogs?: number;
    scheduledRestart: {
        enabled: boolean,
        intervalDays: number,
        reason: string
      }
  };
  intervals?: {
    discoveryFullIntervalMs?: number;
    discoveryLightIntervalMs?: number;
    targetStatePollIntervalMs?: number;
    deviceReportIntervalMs?: number;
    metricsIntervalMs?: number;
    reconciliationIntervalMs?: number;
  };
  protocolAdapters?: {
    modbus?: {
      enabled: boolean;
      tcpHost?: string;
      tcpPort?: number;
      serialPort?: string;
      baudRate?: number;
      slaveRangeStart?: number;
      slaveRangeEnd?: number;
      timeout?: number;
      vendor?: string;
      vendorFile?: string;
    };
    opcua?: {
      enabled: boolean;
      discoveryUrls?: string[];
    };
    snmp?: {
      enabled: boolean;
      ipRanges?: string[];
      port?: number;
    };
  };
}

/**
 * Generate default target state config based on license features
 * 
 * @param licenseData - License data from system_config.license_data
 * @returns Target state configuration object
 */
export function generateDefaultTargetStateConfig(
  licenseData: LicenseData | null
): TargetStateConfig {
  // Default config for trial/basic plan
  const defaultConfig: TargetStateConfig = {
    logging: {
      level: 'info',
      enableRemoteLogging: true,
      enableFilePersistence: false,
      enableCompression: true,
    },
    features: {
      enableDeviceJobs: true, // Always enabled (API access required for system to work)
      enableDeviceSensorPublish: false, // Disabled by default (no OPC-UA server assumed)
      enableDeviceRemoteAccess: true,
      enableProtocolAdapters: true,
      enableFirstBootDiscovery: true,
      enableAnomalyDetection: false, // Disabled by default (resource-intensive)
    },
    settings: {
      stateReportIntervalMs: 10000, // 10 seconds
      memoryCheckIntervalMs: 30000, // 30 seconds
      memoryThresholdMb: 30,
      logMaxAge: 86400000, // 24 hours in ms
      maxLogFileSize: 52428800, // 50 MB
      maxLogs: 10000,
      scheduledRestart: {
        enabled: true,
        intervalDays: 7,
        reason: "heap_fragmentation_cleanup"
      }
    },
    protocolAdapters: {
      modbus: {
        enabled: false, // Disabled by default (no hardware assumed)
        tcpHost: '',
        tcpPort: 502,
        slaveRangeStart: 1,
        slaveRangeEnd: 10,
        timeout: 2000,
        vendor: 'Generic',
        vendorFile: '/app/dist/config/vendors/dataPoints.json',
      },
      opcua: {
        enabled: false,
        discoveryUrls: [],
      },
      snmp: {
        enabled: false,
        ipRanges: [],
        port: 161,
      },
    },
    intervals: {
      discoveryFullIntervalMs: 86400000, // 24 hours
      discoveryLightIntervalMs: 14400000, // 4 hours
      targetStatePollIntervalMs: 60000, // 60 seconds
      deviceReportIntervalMs: 60000, // 60 seconds (matches settings.deviceReportIntervalMs)
      metricsIntervalMs: 60000, // 60 seconds (matches settings.metricsIntervalMs)
      reconciliationIntervalMs: 30000, // 30 seconds
    },
  };

  // If no license data, return default
  if (!licenseData) {
    logger.warn('No license data found - using default config');
    return defaultConfig;
  }

  // Extract plan and features
  const plan = licenseData.plan?.toLowerCase() || 'starter';
  const features = licenseData.features || {};
  const subscriptionActive = licenseData.subscription?.status === 'active';

  logger.info(`Generating target state for plan: ${plan}, active: ${subscriptionActive}`);

  // Note: Intervals are now dashboard-controlled only (not plan-based)
  // Plan-based adjustments only affect logging level
  switch (plan) {
    case 'professional':
      defaultConfig.logging.level = 'info';
      break;

    case 'enterprise':
      defaultConfig.logging.level = 'debug'; // Enhanced logging
      break;

    case 'starter':
    default:
      // Use default values
      break;
  }

  if (features.hasAdvancedAlerts || features.hasCustomDashboards) {
    defaultConfig.logging.level = 'debug';
    logger.info('Enhanced logging (hasAdvancedAlerts/hasCustomDashboards)');
  }

  return defaultConfig;
}

/**
 * Generate complete target state (apps + config) for new device
 * 
 * @param licenseData - License data from system_config
 * @returns Complete target state with empty apps and generated config
 */
export function generateDefaultTargetState(licenseData: LicenseData | null) {
  return {
    apps: {}, // No apps deployed by default
    config: generateDefaultTargetStateConfig(licenseData),
  };
}
