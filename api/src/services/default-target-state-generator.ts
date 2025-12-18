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
  anomaly?: {
    sensitivity: number;
    metrics: Array<{
      name: string;
      enabled: boolean;
      methods: Array<'zscore' | 'mad' | 'iqr' | 'rate_change' | 'ewma' | 'correlation'>;
      threshold: number;
      windowSize: number;
      expectedRange?: [number, number];
      minConfidence?: number;
      cooldownMs?: number;
    }>;
    alerts: {
      mqtt: boolean;
      cloud: boolean;
      minConfidence: number;
      cooldownMs: number;
      maxQueueSize: number;
    };
    storage?: {
      retention: number;  // Days to retain anomaly history
      dbPath?: string;
      minSamples?: number; // Minimum samples required before saving baseline
    };
  };
  intervals?: {
    discoveryFullIntervalMs?: number;
    discoveryLightIntervalMs?: number;
    targetStatePollIntervalMs?: number;
    deviceReportIntervalMs?: number;
    metricsIntervalMs?: number;
    reconciliationIntervalMs?: number;
  };
  protocols?: {
    modbus?: {
      enabled: boolean;
      // Modbus-specific configuration
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
      // OPC-UA specific configuration
      discoveryUrls?: string[];
    };
    snmp?: {
      enabled: boolean;
      // SNMP specific configuration
      ipRanges?: string[];
      port?: number;
    };
    can?: {
      enabled: boolean;
    };
    comap?: {
      enabled: boolean;
    };
  };
  // DEPRECATED: Legacy protocolAdapters for backward compatibility only
  protocolAdapters?: {
    modbus?: {
      enabled?: boolean; // DEPRECATED: Use protocols.modbus.enabled
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
      enabled?: boolean; // DEPRECATED: Use protocols.opcua.enabled
      discoveryUrls?: string[];
    };
    snmp?: {
      enabled?: boolean; // DEPRECATED: Use protocols.snmp.enabled
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
      enableDeviceSensorPublish: true, // Enabled by default (protocols enabled)
      enableDeviceRemoteAccess: true,
      enableAnomalyDetection: true, // Disabled by default (resource-intensive)
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
    anomaly: {
      sensitivity: 5,
      metrics: [
        {
          name: 'cpu_usage',
          enabled: true,
          methods: ['zscore', 'ewma'],
          threshold: 3.0,
          windowSize: 100,
          expectedRange: [0, 85],
        },
        {
          name: 'memory_percent',
          enabled: true,
          methods: ['zscore', 'ewma', 'rate_change'],
          threshold: 3.0,
          windowSize: 200,
          expectedRange: [0, 85],
        },
        {
          name: 'cpu_temp',
          enabled: true,
          methods: ['zscore', 'mad'],
          threshold: 3.0,
          windowSize: 300,
          expectedRange: [30, 80],
        },
      ],
      alerts: {
        mqtt: true,
        cloud: true,
        minConfidence: 0.7,
        cooldownMs: 300000,  // 5 minutes
        maxQueueSize: 1000,
      },
      storage: {
        retention: 30,  // Automatic cleanup after 30 days (uses existing device.sqlite)
        minSamples: 5,  // Minimum data points required before saving baseline (5 samples = ~5 minutes at 60s interval)
      },
    },
    protocols: {
      modbus: {
        enabled: true, // Enabled by default with simulator
        tcpHost: 'localhost', // Always use localhost for agent discovery
        tcpPort: 502,
        slaveRangeStart: 1,
        slaveRangeEnd: 10,
        timeout: 2000,
        vendor: 'Generic',
        vendorFile: '/app/dist/config/vendors/dataPoints.json',
      },
      opcua: {
        enabled: true, // Enabled by default for discovery
        discoveryUrls: [],
      },
      snmp: {
        enabled: false,
        ipRanges: [],
        port: 161,
      },
      can: {
        enabled: false,
      },
      comap: {
        enabled: false,
      },
    },
    intervals: {
      discoveryFullIntervalMs: 86400000, // 24 hours
      discoveryLightIntervalMs: 300000, // 1 minute (for testing - change to 14400000 for production)
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
 * @returns Complete target state with preinstalled core services and generated config
 */
export function generateDefaultTargetState(licenseData: LicenseData | null) {
  return {
    apps: {
      "1000": {
        appId: "1000",
        appName: "core-services",
        services: [
          {
            serviceId: 1,
            serviceName: "mosquitto",
            imageName: "eclipse-mosquitto:2.0",
            config: {
              image: "eclipse-mosquitto:2.0",
              ports: ["1883:1883", "9001:9001"],
              volumes: [
                "mosquitto-data:/mosquitto/data",
                "mosquitto-config:/mosquitto/config",
                "mosquitto-log:/mosquitto/log"
              ],
              restart: "unless-stopped",
              networks: ["default"]
            }
          },
          {
            serviceId: 2,
            serviceName: "nodered",
            imageName: "nodered/node-red:latest",
            config: {
              image: "nodered/node-red:latest",
              ports: ["8880:1880"],
              volumes: ["nodered-data:/data"],
              environment: {
                "TZ": "UTC"
              },
              restart: "unless-stopped",
              networks: ["default"]
            }
          }
        ]
      }
    },
    config: generateDefaultTargetStateConfig(licenseData),
  };
}
