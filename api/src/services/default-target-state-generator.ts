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
import { query } from '../db/connection.js';
import { 
  TargetState, 
  profileDataPointsToPointsObject,
  type ModbusProfileDataPoint 
} from '../types/target-state.js';

/**
 * Fetch profile data points from database
 */
async function getProfileDataPoints(profileName: string, protocol: string = 'modbus'): Promise<any[]> {
  try {
    const result = await query(
      'SELECT data_points FROM profile_configs WHERE profile_name = $1 AND protocol = $2',
      [profileName, protocol]
    );
    return result.rows[0]?.data_points || [];
  } catch (error) {
    console.error(`Failed to fetch profile config for ${profileName}:`, error);
    return [];
  }
}

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
  };
}

/**
 * Generate protocols configuration based on simulator options or defaults
 */
function generateProtocolsConfig(simulatorOptions?: SimulatorOptions) {
  // If no simulator options provided, return default configuration for dev/edge devices
  if (!simulatorOptions || !simulatorOptions.simulatorConfig) {
    return {
      can: {
        enabled: false,
        bufferCapacity: 64 * 1024,
      },
      snmp: {
        enabled: true,
        port: 161,
        ipRanges: ["10.0.0.60"],
        bufferCapacity: 128 * 1024,
      },
      mqtt: {
        enabled: false,
        connection: {
          brokerUrl: 'mqtt://10.0.0.60:1883',
        },
        discoveryRoots: [
          'edge/+',
          'sensor/+/data'
        ],
        monitorDurationMs: 30000,
        qos: 0 as 0 | 1 | 2,
        bufferCapacity: 512 * 1024,
      },
      opcua: {
        enabled: true,
        discoveryUrls: ["opc.tcp://10.0.0.60:4840"],
        bufferCapacity: 1024 * 1024,
      },
      modbus: {
        enabled: true,
        bufferCapacity: 128 * 1024,
        connections: [
          {
            name: 'modbus-sim-1',
            host: '10.0.0.60',
            port: 502,
            enabled: false, // Default to disabled - user enables after discovery
            timeoutMs: 2000,
            profile: 'Generic',
            addressing: {
              slaveRange: {
                start: 1,
                end: 10,
              },
            },
          },
          {
            name: 'modbus-sim-2',
            host: '10.0.0.60',
            port: 503,
            enabled: false, // Default to disabled - user enables after discovery
            timeoutMs: 2000,
            profile: 'Generic',
            addressing: {
              slaveRange: {
                start: 1,
                end: 10,
              },
            },
          },
          {
            name: 'modbus-sim-3',
            host: '10.0.0.60',
            port: 504,
            enabled: false, // Default to disabled - user enables after discovery
            timeoutMs: 2000,
            profile: 'Generic',
            addressing: {
              slaveRange: {
                start: 1,
                end: 10,
              },
            },
          }
        ],
      },
    };
  }
  
  // K8s fleet deployment with dynamic simulator config
  const simConfig = simulatorOptions.simulatorConfig;
  
  // Generate Modbus connections
  const modbusConnections = [];
  if (simConfig.modbus && simConfig.modbus.count > 0) {
    const { count, startPort, host, profile = 'Generic' } = simConfig.modbus;
    
    for (let i = 0; i < count; i++) {
      modbusConnections.push({
        name: `modbus-sim-${i + 1}`,
        host: host,
        port: startPort + i,
        enabled: false, // Default to disabled - user enables after discovery
        timeoutMs: 2000,
        profile: profile,
        addressing: {
          slaveRange: {
            start: 1,
            end: 10,
          },
        },
      });
    }
  }
  
  // Generate OPC-UA discovery URLs
  const opcuaUrls = [];
  if (simConfig.opcua && simConfig.opcua.count > 0) {
    const { count, startPort, host } = simConfig.opcua;
    
    for (let i = 0; i < count; i++) {
      opcuaUrls.push(`opc.tcp://${host}:${startPort + i}`);
    }
  }
  
  // Generate SNMP IP ranges
  const snmpRanges = simConfig.snmp?.ipRanges || [];
  
  return {
    can: {
      enabled: false,
      bufferCapacity: 64 * 1024,
    },
    snmp: {
      enabled: snmpRanges.length > 0,
      port: 161,
      ipRanges: snmpRanges,
      bufferCapacity: 128 * 1024,
    },
    mqtt: {
      enabled: false,
      connection: {
        brokerUrl: '',
      },
      discoveryRoots: [
        'edge/+',
        'sensor/+/data'
      ],
      monitorDurationMs: 30000,
      qos: 0 as 0 | 1 | 2,
      bufferCapacity: 512 * 1024,
    },
    opcua: {
      enabled: opcuaUrls.length > 0,
      discoveryUrls: opcuaUrls,
      bufferCapacity: 1024 * 1024,
    },
    modbus: {
      enabled: modbusConnections.length > 0,
      bufferCapacity: 128 * 1024,
      connections: modbusConnections,
    },
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
  profileDataPoints: ModbusProfileDataPoint[] = [],
  simulatorOptions?: SimulatorOptions
): TargetState {
  // Transform profileDataPoints array → points object
  const modbusPoints = profileDataPointsToPointsObject(profileDataPoints);
  
  // Default config
  const defaultConfig: TargetState = {
    anomalyDetection: {
      alerts: {
        cooldownMs: 300000,  // 5 minutes (agent-side alert deduplication)
        maxQueueSize: 1000,  // Max alerts in agent memory queue
      },
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
        enabled: true,
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
    },
    protocols: generateProtocolsConfig(simulatorOptions),
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

  logger.info(`Generating V2 target state for plan: ${plan}, active: ${subscriptionActive}`);

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
  licenseData: LicenseData | null,
  simulatorOptions?: SimulatorOptions
) {
  // Generate config with connection profiles defined
  const config = generateDefaultTargetStateConfig(licenseData, [], simulatorOptions);
  
  // Load points for each connection based on its profile
  if (config.protocols.modbus.connections) {
    for (const connection of config.protocols.modbus.connections) {
      if (connection.profile) {
        const profileDataPoints = await getProfileDataPoints(connection.profile, 'modbus');
        connection.points = profileDataPointsToPointsObject(profileDataPoints as ModbusProfileDataPoint[]);
        logger.info(`Loaded ${Object.keys(connection.points).length} points for ${connection.name} (${connection.profile})`);
      }
    }
  }
  
  return {
    apps: {
      "1000": {
        appId: "1000",
        appName: "core-services",
        services: [
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
    config,  // V2 config with points object
  };
}