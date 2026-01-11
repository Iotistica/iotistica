/**
 * MQTT Broker Configuration Utilities
 * 
 * Priority order for broker configuration:
 * 1. Environment variables (MQTT_BROKER_HOST, MQTT_BROKER_PORT, MQTT_BROKER_PROTOCOL)
 * 2. Device-specific broker assignment (devices.mqtt_broker_id)
 * 3. Default broker (mqtt_broker_config.is_default = true)
 * 
 * Database: Uses mqtt_broker_config table directly (not system_config)
 */

import { query } from '../db/connection';

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
 * 
 * Priority order:
 * 1. Environment variables (full override if all required vars present)
 * 2. Environment MQTT_BROKER_TYPE preference ('local' or 'cloud')
 * 3. Device-specific broker assignment (devices.mqtt_broker_id)
 * 4. Default broker from database
 * 
 * @param deviceUuid - Device UUID
 * @returns Broker configuration or null if not found
 */
export async function getBrokerConfigForDevice(deviceUuid: string): Promise<MqttBrokerConfig | null> {
  try {
    // Priority 1: Full environment override (e2e, docker-compose, k8s)
    const envHost = process.env.MQTT_BROKER_HOST;
    const envPort = process.env.MQTT_BROKER_PORT;
    const envProtocol = process.env.MQTT_BROKER_PROTOCOL;
    
    if (envHost && envPort && envProtocol) {
      console.log(`[MQTT Config] Environment override for device ${deviceUuid}:`, {
        protocol: envProtocol,
        host: envHost,
        port: envPort,
        use_tls: process.env.MQTT_BROKER_USE_TLS === 'true'
      });
      
      return createConfigFromEnv();
    }
    
    // Priority 2: Environment broker type preference (local vs cloud)
    const preferredBrokerType = process.env.MQTT_BROKER_TYPE; // 'local' or 'cloud'
    
    if (preferredBrokerType) {
      const typeResult = await query(
        `SELECT * FROM mqtt_broker_config 
         WHERE broker_type = $1 AND is_active = true 
         ORDER BY is_default DESC, id ASC
         LIMIT 1`,
        [preferredBrokerType]
      );
      
      if (typeResult.rows.length > 0) {
        console.log(`[MQTT Config] Using ${preferredBrokerType} broker for device ${deviceUuid}:`, {
          name: typeResult.rows[0].name,
          protocol: typeResult.rows[0].protocol,
          host: typeResult.rows[0].host,
          port: typeResult.rows[0].port
        });
        return typeResult.rows[0];
      } else {
        console.log(`[MQTT Config] No ${preferredBrokerType} broker found, falling back to default`);
      }
    }
    
    // Priority 3: Device-specific broker from mqtt_broker_config table
    const deviceResult = await query(
      `SELECT bc.* FROM mqtt_broker_config bc
       JOIN devices d ON d.mqtt_broker_id = bc.id
       WHERE d.uuid = $1 AND bc.is_active = true`,
      [deviceUuid]
    );
    
    if (deviceResult.rows.length > 0) {
      console.log(`[MQTT Config] Device-specific broker for ${deviceUuid}:`, {
        name: deviceResult.rows[0].name,
        protocol: deviceResult.rows[0].protocol,
        host: deviceResult.rows[0].host,
        port: deviceResult.rows[0].port
      });
      return deviceResult.rows[0];
    }
    
    // Priority 4: Default broker from mqtt_broker_config table
    const defaultResult = await query(
      `SELECT * FROM mqtt_broker_config 
       WHERE is_default = true AND is_active = true 
       LIMIT 1`
    );
    
    if (defaultResult.rows.length > 0) {
      console.log(`[MQTT Config] Default broker for ${deviceUuid}:`, {
        name: defaultResult.rows[0].name,
        protocol: defaultResult.rows[0].protocol,
        host: defaultResult.rows[0].host,
        port: defaultResult.rows[0].port
      });
      return defaultResult.rows[0];
    }
    
    console.warn(`[MQTT Config] No broker found for device ${deviceUuid}`);
    return null;
  } catch (error) {
    console.error(`[MQTT Config] Error fetching broker config for device ${deviceUuid}:`, error);
    return null;
  }
}

/**
 * Get broker configuration for external device provisioning
 * Uses MQTT_BROKER_EXTERNAL_HOST/PORT for devices connecting from outside K8s
 * 
 * Priority order:
 * 1. Environment variables with external host override (MQTT_BROKER_EXTERNAL_HOST)
 * 2. Environment MQTT_BROKER_TYPE preference ('local' or 'cloud')
 * 3. Device-specific broker from database
 * 4. Default broker from database
 * 
 * @param deviceUuid - Device UUID
 * @returns Broker configuration with external address or null if not found
 */
export async function getBrokerConfigForExternalDevice(deviceUuid: string): Promise<MqttBrokerConfig | null> {
  try {
    // Priority 1: Environment broker type preference (local vs cloud)
    // Removed full environment override - always use database for provisioning
    const preferredBrokerType = process.env.MQTT_BROKER_TYPE;
    
    if (preferredBrokerType) {
      const typeResult = await query(
        `SELECT * FROM mqtt_broker_config 
         WHERE broker_type = $1 AND is_active = true 
         ORDER BY is_default DESC, id ASC
         LIMIT 1`,
        [preferredBrokerType]
      );
      
      if (typeResult.rows.length > 0) {
        console.log(`[MQTT Config] Using ${preferredBrokerType} broker for external device ${deviceUuid}:`, {
          name: typeResult.rows[0].name,
          protocol: typeResult.rows[0].protocol,
          host: typeResult.rows[0].host,
          port: typeResult.rows[0].port
        });
        return typeResult.rows[0];
      } else {
        console.log(`[MQTT Config] No ${preferredBrokerType} broker found, falling back to default`);
      }
    }
    
    // Priority 3 & 4: Fall back to device-specific or default broker
    return getBrokerConfigForDevice(deviceUuid);
  } catch (error) {
    console.error(`[MQTT Config] Error fetching external broker config for device ${deviceUuid}:`, error);
    return null;
  }
}

/**
 * Create broker configuration from environment variables
 */
function createConfigFromEnv(): MqttBrokerConfig {
  return {
    id: 0, // Virtual config (not from database)
    name: 'Environment Override',
    protocol: process.env.MQTT_BROKER_PROTOCOL || 'mqtt',
    host: process.env.MQTT_BROKER_HOST || 'localhost',
    port: parseInt(process.env.MQTT_BROKER_PORT || '1883', 10),
    username: process.env.MQTT_BROKER_USERNAME || process.env.MQTT_USERNAME || null,
    use_tls: process.env.MQTT_BROKER_USE_TLS === 'true',
    ca_cert: process.env.MQTT_BROKER_CA_CERT || null,
    client_cert: process.env.MQTT_BROKER_CLIENT_CERT || null,
    verify_certificate: process.env.MQTT_BROKER_VERIFY_CERT !== 'false',
    client_id_prefix: process.env.MQTT_CLIENT_ID_PREFIX || 'Iotistic',
    keep_alive: parseInt(process.env.MQTT_KEEP_ALIVE || '60', 10),
    clean_session: process.env.MQTT_CLEAN_SESSION !== 'false',
    reconnect_period: parseInt(process.env.MQTT_RECONNECT_PERIOD || '1000', 10),
    connect_timeout: parseInt(process.env.MQTT_CONNECT_TIMEOUT || '30000', 10),
    broker_type: process.env.MQTT_BROKER_TYPE || 'local'
  };
}

/**
 * Create broker configuration from environment variables - EXTERNAL variant
 * This uses MQTT_BROKER_EXTERNAL_HOST/PORT for device connections outside K8s
 * Falls back to internal host if external not configured
 */
function createConfigFromEnvExternal(): MqttBrokerConfig {
  const config = createConfigFromEnv();
  
  // Use external host/port if configured (for devices connecting from outside K8s)
  if (process.env.MQTT_BROKER_EXTERNAL_HOST) {
    config.host = process.env.MQTT_BROKER_EXTERNAL_HOST;
  }
  if (process.env.MQTT_BROKER_EXTERNAL_PORT) {
    config.port = parseInt(process.env.MQTT_BROKER_EXTERNAL_PORT, 10);
  }
  
  return config;
}

/**
 * Get the default broker configuration
 * 
 * Priority order:
 * 1. Environment variables (if all required vars present)
 * 2. Default broker from mqtt_broker_config table
 * 
 * @returns Default broker configuration or null if not found
 */
export async function getDefaultBrokerConfig(): Promise<MqttBrokerConfig | null> {
  try {
    // Priority 1: Environment override
    const envHost = process.env.MQTT_BROKER_HOST;
    const envPort = process.env.MQTT_BROKER_PORT;
    const envProtocol = process.env.MQTT_BROKER_PROTOCOL;
    
    if (envHost && envPort && envProtocol) {
      console.log(`[MQTT Config] Environment override: ${envProtocol}://${envHost}:${envPort}`);
      return createConfigFromEnv();
    }
    
    // Priority 2: Default broker from database
    const result = await query(
      `SELECT * FROM mqtt_broker_config 
       WHERE is_default = true AND is_active = true 
       LIMIT 1`
    );
    
    if (result.rows.length === 0) {
      console.warn('[MQTT Config] No default broker found in database');
      return null;
    }
    
    const config = result.rows[0];
    console.log(`[MQTT Config] Database default: ${config.protocol}://${config.host}:${config.port}`);
    return config;
  } catch (error) {
    console.error('[MQTT Config] Error fetching default broker:', error);
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
 * Formats for client consumption with optional credentials
 * 
 * @param config - Broker configuration from database (snake_case)
 * @param credentials - Optional MQTT credentials { username, password }
 * @returns Complete broker configuration object (camelCase)
 */
export function formatBrokerConfigForClient(config: any, credentials?: { username: string; password: string }) {
  // Support both snake_case (from database) and camelCase (from env)
  const useTls = config.use_tls ?? config.useTls ?? false;
  const caCert = config.ca_cert ?? config.caCert ?? null;
  const clientCert = config.client_cert ?? config.clientCert ?? null;
  const verifyCertificate = config.verify_certificate ?? config.verifyCertificate ?? true;
  const clientIdPrefix = config.client_id_prefix ?? config.clientIdPrefix ?? 'Iotistic';
  const keepAlive = config.keep_alive ?? config.keepAlive ?? 60;
  const cleanSession = config.clean_session ?? config.cleanSession ?? true;
  const reconnectPeriod = config.reconnect_period ?? config.reconnectPeriod ?? 1000;
  const connectTimeout = config.connect_timeout ?? config.connectTimeout ?? 30000;

  return {
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    ...(credentials && {
      username: credentials.username,
      password: credentials.password
    }),
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
    console.error('[MQTT Config] Error assigning broker to device:', error);
    return false;
  }
}
