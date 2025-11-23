/**
 * MQTT Broker Configuration Utilities
 * Helper functions for managing and retrieving MQTT broker configurations
 */

import { query } from '../db/connection';
import { SystemConfig } from '../config/system-config';

export interface MqttBrokerConfig {
  id: number;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string | null;
  use_tls: boolean;
  ca_cert: string | null;
  client_cert: string | null;
  verify_certificate: boolean;
  client_id_prefix: string;
  keep_alive: number;
  clean_session: boolean;
  reconnect_period: number;
  connect_timeout: number;
  broker_type: string;
}

/**
 * Get broker configuration for a specific device
 * Falls back to default broker if device has no specific broker assigned
 * 
 * @param deviceUuid - Device UUID
 * @returns Broker configuration or null if not found
 */
export async function getBrokerConfigForDevice(deviceUuid: string): Promise<MqttBrokerConfig | null> {
  try {
    // Priority 1: Check environment variable override (same as getDefaultBrokerConfig)
    const envHost = process.env.MQTT_BROKER_HOST;
    const envPort = process.env.MQTT_BROKER_PORT;
    
    
    // Priority 2: Query database for device-specific broker ID, then use SystemConfig
    const deviceResult = await query(
      `SELECT mqtt_broker_id FROM devices WHERE uuid = $1`,
      [deviceUuid]
    );
    
    const brokerId = deviceResult.rows[0]?.mqtt_broker_id;
    
    // Use SystemConfig to get broker (uses device-specific or default)
    const config = await SystemConfig.getMqttBroker(brokerId);
    
    // Override with environment variables if TLS is disabled and env vars are set
    if (config.use_tls === false && envHost && envPort) {
      config.host = envHost;
      config.port = parseInt(envPort, 10);
      console.log(`[MQTT Config] TLS disabled for device ${deviceUuid}, using env override: ${envHost}:${envPort}`);
    }   
    
    return config || null;
  } catch (error) {
    console.error('Error fetching broker config for device:', error);
    return null;
  }
}

/**
 * Get the default broker configuration
 * Priority: Environment variables > Database > null
 * 
 * This allows:
 * - K8s deployments to inject namespace URLs via env vars
 * - Customers to configure external brokers via UI (database)
 * - Flexible override for cloud brokers (HiveMQ, AWS IoT, etc.)
 * 
 * @returns Default broker configuration or null if not found
 */
export async function getDefaultBrokerConfig(): Promise<MqttBrokerConfig | null> {
  try {
    // Priority 1: Check environment variable override
    const envHost = process.env.MQTT_BROKER_HOST;
    const envPort = process.env.MQTT_BROKER_PORT;
    
    if (envHost && envPort) {
      console.log(`[MQTT Config] Using environment override: ${envHost}:${envPort}`);
      return {
        id: 0, // Virtual config, not from DB
        name: 'Environment Override',
        protocol: process.env.MQTT_BROKER_PROTOCOL || 'mqtt',
        host: envHost,
        port: parseInt(envPort, 10),
        username: process.env.MQTT_BROKER_USERNAME || null,
        use_tls: process.env.MQTT_BROKER_USE_TLS === 'true',
        ca_cert: process.env.MQTT_BROKER_CA_CERT || null,
        client_cert: process.env.MQTT_BROKER_CLIENT_CERT || null,
        verify_certificate: process.env.MQTT_BROKER_VERIFY_CERT !== 'false', // Default true
        client_id_prefix: process.env.MQTT_CLIENT_ID_PREFIX || 'Iotistic',
        keep_alive: parseInt(process.env.MQTT_KEEP_ALIVE || '60', 10),
        clean_session: process.env.MQTT_CLEAN_SESSION !== 'false', // Default true
        reconnect_period: parseInt(process.env.MQTT_RECONNECT_PERIOD || '1000', 10),
        connect_timeout: parseInt(process.env.MQTT_CONNECT_TIMEOUT || '30000', 10),
        broker_type: process.env.MQTT_BROKER_TYPE || 'cloud'
      };
    }
    
    // Priority 2: Fallback to database configuration via SystemConfig
    const config = await SystemConfig.getMqttBroker(); // No ID = use default
    
    if (!config) {
      console.warn('[MQTT Config] No default broker configuration found');
      return null;
    }
    
    console.log(`[MQTT Config] Using database default: ${config.host}:${config.port}`);
    return config;
  } catch (error) {
    console.error('Error fetching default broker config:', error);
    return null;
  }
}

/**
 * Build broker URL from configuration
 * 
 * @param config - Broker configuration
 * @returns Full broker URL (e.g., "mqtt://localhost:1883")
 */
export function buildBrokerUrl(config: MqttBrokerConfig): string {
  return `${config.protocol}://${config.host}:${config.port}`;
}

/**
 * Format broker configuration for API response
 * Removes sensitive information and formats for client consumption
 * 
 * @param config - Broker configuration (supports both snake_case and camelCase)
 * @returns Sanitized broker configuration object
 */
export function formatBrokerConfigForClient(config: any) {
  const useTls = config.useTls ?? false;
  const caCert = config.caCert ?? null;
  const clientCert = config.clientCert ?? null;
  const verifyCertificate = config.verifyCertificate ??  true;
  const clientIdPrefix = config.clientIdPrefix ?? 'Iotistic';
  const keepAlive = config.keepAlive ?? 60;
  const cleanSession = config.cleanSession ?? true;
  const reconnectPeriod = config.reconnectPeriod ?? 1000;
  const connectTimeout = config.connectTimeout ?? 30000;

  return {
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    useTls,
    clientIdPrefix,
    keepAlive,
    cleanSession,
    reconnectPeriod,
    connectTimeout,
    // Include TLS-related fields only if TLS is enabled
    ...(useTls && {
      verifyCertificate,
      ...(caCert && { caCert }),
      ...(clientCert && { clientCert })
    })
  };
}

/**
 * Assign a broker to a device
 * 
 * @param deviceUuid - Device UUID
 * @param brokerId - Broker configuration ID (null to use default)
 * @returns Success status
 */
export async function assignBrokerToDevice(deviceUuid: string, brokerId: number | null): Promise<boolean> {
  try {
    await query(
      `UPDATE devices 
       SET mqtt_broker_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE uuid = $2`,
      [brokerId, deviceUuid]
    );
    return true;
  } catch (error) {
    console.error('Error assigning broker to device:', error);
    return false;
  }
}
