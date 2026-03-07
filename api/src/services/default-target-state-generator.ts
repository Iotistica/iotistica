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
import { 
  TargetState
} from '../types/target-state.js';


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

interface SimulatorOptions {
  deploymentType?: 'k8s-fleet' | 'edge-device' | 'standalone';
  simulatorConfig?: {
    modbus?: {
      count: number;
      startPort: number;
      host: string;
      profile?: string;
    };
    opcua?: {
      count: number;
      startPort: number;
      host: string;
    };
    snmp?: {
      ipRanges: string[];
    };
    bacnet?: {
      discoveryTargets?: string[];  // Unicast discovery targets (recommended for containers)
      broadcastAddress?: string;    // Legacy broadcast mode
      port?: number;
      timeout?: number;
    };
  };
}


/**
 * Generate default target state config
 * 
 * @param licenseData - License data from system_config
 * @param profileDataPoints - Profile data points from database (array format)
 * @param simulatorOptions - Simulator configuration from provisioning (optional)
 * @returns Target state configuration object
 */
export function generateDefaultTargetStateConfig(
  licenseData: LicenseData | null,
): TargetState {
  
  // Default config
  const defaultConfig: TargetState = {
    anomalyDetection: {
      enabled: true,  // Global anomaly detection toggle
      defaults: {
        methods: ['mad'],  // Default detection method (robust for noisy data)
        threshold: 3.0,    // Default sensitivity threshold
        windowSize: 120,   // Default rolling window size
        minSamples: 5,     // Minimum samples before detection starts
      },
      alerts: {
        cooldownMs: 300000,   // 5 minutes (agent-side alert deduplication)
        maxQueueSize: 1000,   // Max alerts in agent memory queue
        minConfidence: 0.7,   // Minimum confidence threshold to generate alerts (0-1)
      },
      systemMetrics: [
        {
          name: 'cpu_usage',
          enabled: true,
          methods: ['zscore', 'ewma'],  // Override default methods for CPU
          threshold: 3.0,
          windowSize: 100,
          expectedRange: [0, 85],
        },
        {
          name: 'memory_percent',
          enabled: true,
          methods: ['zscore', 'ewma', 'rate_change'],  // Override default methods for memory
          threshold: 3.0,
          windowSize: 200,
          expectedRange: [0, 85],
        },
        {
          name: 'cpu_temp',
          enabled: true,
          methods: ['zscore', 'mad'],  // Override default methods for temperature
          threshold: 3.0,
          windowSize: 300,
          expectedRange: [30, 80],
        },
      ],
      storage: {
        retention: 30,  // Days
        minSamples: 5,
      },
      sensitivity: 5,
      warmupPeriodMs: 900000,  // 15 minutes (suppress alerts during agent initialization)
    },
    logging: {
      level: 'debug',  // Default to debug for better visibility
      enableCompression: true,
      enableRemoteLogging: true,
      enableFilePersistence: false,
      maxLogs: 10000,
      logMaxAge: 86400000,  // 24 hours in ms
      maxLogFileSize: 52428800,  // 50 MB
    },
    features: {
      enableDeviceJobs: false,
      enableAnomalyDetection: false,
      enableDeviceRemoteAccess: true,
      enableDeviceSensorPublish: true,
    },
    runtime: {
      scheduledRestart: {
        reason: 'heap_fragmentation_cleanup',
        enabled: false,
        intervalDays: 7,
      },
      memory: {
        thresholdMb: 30,
        checkIntervalMs: 30000,  // 30 seconds
      },
    },
    intervals: {
      device: {
        metricsIntervalMs: 60000,  // 60 seconds
        reportIntervalMs: 60000,  // 60 seconds
        reconciliationIntervalMs: 30000,  // 30 seconds
        targetStatePollIntervalMs: 60000,  // 60 seconds
      },
      discovery: {
        fullIntervalMs: 86400000,  // 24 hours
        lightIntervalMs: 14400000,  // 4 hours
      },
    }
  };

  // If no license data, return default
  if (!licenseData) {
    logger.warn('No license data found - using default V2 config');
    return defaultConfig;
  }

  // Extract plan and features
  const plan = licenseData.plan?.toLowerCase() || 'starter';
  const features = licenseData.features || {};
  const subscriptionActive = licenseData.subscription?.status === 'active';

  logger.info(`Generating target state for plan: ${plan}, active: ${subscriptionActive}`);

  // Plan-based adjustments for logging level
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
 * Generate complete target state V2 (apps + config) for new device
 * 
 * @param licenseData - License data from system_config
 * @param simulatorOptions - Simulator configuration from provisioning (optional)
 * @returns Complete target state with preinstalled core services and generated config
 */
export async function generateDefaultTargetState(
  licenseData: LicenseData | null

) {
  // Generate config with connection profiles defined
  const config = generateDefaultTargetStateConfig(licenseData);
 
  
  return {
    apps: {
      // "1000": {
      //   appId: "1000",
      //   appName: "core-services",
      //   services: [
          // {
          //   serviceId: 1,
          //   serviceName: "mosquitto",
          //   imageName: "eclipse-mosquitto:2.0",
          //   config: {
          //     image: "eclipse-mosquitto:2.0",
          //     ports: ["1883:1883", "9001:9001"],
          //     volumes: [
          //       "mosquitto-data:/mosquitto/data",
          //       "mosquitto-config:/mosquitto/config",
          //       "mosquitto-log:/mosquitto/log"
          //     ],
          //     command: ["mosquitto", "-c", "/mosquitto-no-auth.conf"],
          //     restart: "unless-stopped",
          //     networks: ["default"]
          //   }
          // },
          // {
          //   serviceId: 2,
          //   serviceName: "nodered",
          //   imageName: "nodered/node-red:latest",
          //   config: {
          //     image: "nodered/node-red:latest",
          //     ports: ["8880:1880"],
          //     volumes: ["nodered-data:/data"],
          //     environment: {
          //       "TZ": "UTC"
          //     },
          //     restart: "unless-stopped",
          //     networks: ["default"]
          //   }
          // }
        //]
      //}
    },
    config,  // V2 config with points object
  };
}