/**
 * VPN Configuration Utilities
 * Helper functions for managing and retrieving VPN configurations
 * Similar pattern to mqtt-broker-config.ts
 */

import { query } from '../db/connection';
import { SystemConfig } from '../services/config/system-config';

export interface VpnConfig {
  id: number;
  name: string;
  description: string | null;
  enabled: boolean;
  server_host: string;
  server_port: number;
  protocol: string;
  ca_cert_url: string | null;
  ca_cert: string | null;
  vpn_subnet: string;
  vpn_netmask: string;
  cipher: string;
  auth: string;
  compress_lzo: boolean;
  is_default: boolean;
  is_active: boolean;
}

/**
 * Get VPN configuration for a specific device
 * Falls back to default VPN config if device has no specific config assigned
 * 
 * Priority:
 * 1. Device-specific VPN config (agents.vpn_config_id)
 * 2. Default VPN config (vpn_config.is_default = true)
 * 3. Environment variables (VPN_ENABLED, VPN_SERVER_HOST, etc.)
 * 4. NULL (VPN disabled)
 * 
 * @param deviceUuid - Device UUID
 * @returns VPN configuration or null if VPN is disabled
 */
export async function getVpnConfigForDevice(deviceUuid: string): Promise<VpnConfig | null> {
  try {
    // Check environment variable override first
    const envEnabled = process.env.VPN_ENABLED === 'true';
    if (!envEnabled) {
      // VPN explicitly disabled via environment
      return null;
    }
    
    const envHost = process.env.VPN_SERVER_HOST;
    const envPort = process.env.VPN_SERVER_PORT;
    
    if (envHost && envPort) {
      // Use environment variables (K8s deployment override)
      console.log(`[VPN Config] Using environment override: ${envHost}:${envPort}`);
      return {
        id: 0, // Virtual config, not from DB
        name: 'Environment Override',
        description: 'VPN configuration from environment variables',
        enabled: true,
        server_host: envHost,
        server_port: parseInt(envPort, 10),
        protocol: process.env.VPN_PROTOCOL || 'udp',
        ca_cert_url: process.env.VPN_CA_URL || null,
        ca_cert: null, // Fetched on-demand
        vpn_subnet: process.env.VPN_SUBNET || '10.8.0.0',
        vpn_netmask: process.env.VPN_NETMASK || '255.255.0.0',
        cipher: process.env.VPN_CIPHER || 'AES-256-GCM',
        auth: process.env.VPN_AUTH || 'SHA256',
        compress_lzo: process.env.VPN_COMPRESS_LZO !== 'false',
        is_default: false,
        is_active: true
      };
    }
    
    // Query device-specific config ID from agents table
    const deviceResult = await query(
      `SELECT vpn_config_id FROM agents WHERE uuid = $1`,
      [deviceUuid]
    );
    
    const configId = deviceResult.rows[0]?.vpn_config_id;
    
    // Use SystemConfig to get config (uses device-specific or default)
    const config = await SystemConfig.getVpnConfig(configId);
    
    if (!config) {
      console.log('[VPN Config] No VPN configuration found for device');
      return null;
    }
    
    // Check if VPN is enabled and active
    if (!config.enabled || !config.is_active) {
      console.log('[VPN Config] VPN is disabled in configuration');
      return null;
    }
    
    console.log(`[VPN Config] Using database config: ${config.name} (${config.server_host}:${config.server_port})`);
    return config;
  } catch (error) {
    console.error('Error fetching VPN config for device:', error);
    return null;
  }
}

/**
 * Get the default VPN configuration
 * 
 * @returns Default VPN configuration or null if not found/disabled
 */
export async function getDefaultVpnConfig(): Promise<VpnConfig | null> {
  try {
    // Check environment override first
    const envEnabled = process.env.VPN_ENABLED === 'true';
    const envHost = process.env.VPN_SERVER_HOST;
    const envPort = process.env.VPN_SERVER_PORT;
    
    if (envEnabled && envHost && envPort) {
      return {
        id: 0,
        name: 'Environment Override',
        description: 'VPN configuration from environment variables',
        enabled: true,
        server_host: envHost,
        server_port: parseInt(envPort, 10),
        protocol: process.env.VPN_PROTOCOL || 'udp',
        ca_cert_url: process.env.VPN_CA_URL || null,
        ca_cert: null,
        vpn_subnet: process.env.VPN_SUBNET || '10.8.0.0',
        vpn_netmask: process.env.VPN_NETMASK || '255.255.0.0',
        cipher: process.env.VPN_CIPHER || 'AES-256-GCM',
        auth: process.env.VPN_AUTH || 'SHA256',
        compress_lzo: process.env.VPN_COMPRESS_LZO !== 'false',
        is_default: false,
        is_active: true
      };
    }
    
    // Fallback to database via SystemConfig
    const config = await SystemConfig.getVpnConfig(); // No ID = use default
    
    if (!config) {
      console.log('[VPN Config] No default VPN configuration found');
      return null;
    }
    
    // Check if enabled and active
    if (!config.enabled || !config.is_active) {
      console.log('[VPN Config] Default VPN configuration is disabled or inactive');
      return null;
    }
    
    console.log(`[VPN Config] Using database default: ${config.name} (${config.server_host}:${config.server_port})`);
    return config;
  } catch (error) {
    console.error('Error fetching default VPN config:', error);
    return null;
  }
}

/**
 * Format VPN configuration for provisioning response
 * 
 * @param config - VPN configuration
 * @param credentials - VPN credentials for device
 * @param caCert - CA certificate content
 * @returns Formatted VPN configuration for device
 */
export function formatVpnConfigForDevice(
  config: VpnConfig,
  credentials: { username: string; password: string },
  caCert: string
) {
  return {
    enabled: true,
    credentials: {
      username: credentials.username,
      password: credentials.password
    },
    server: {
      host: config.server_host,
      port: config.server_port,
      protocol: config.protocol
    },
    config: generateOvpnConfig(credentials.username, caCert, config)
  };
}

/**
 * Generate OpenVPN client configuration
 * 
 * @param deviceUuid - Device UUID (used as CN)
 * @param caCert - CA certificate content
 * @param config - VPN configuration
 * @returns Complete .ovpn configuration file content
 */
function generateOvpnConfig(deviceUuid: string, caCert: string, config: VpnConfig): string {
  return `client
dev tun
proto ${config.protocol}
remote ${config.server_host} ${config.server_port}
resolv-retry infinite
nobind
persist-key
persist-tun
auth-user-pass
remote-cert-tls server
cipher ${config.cipher}
auth ${config.auth}
${config.compress_lzo ? 'comp-lzo adaptive' : ''}
verb 3

<ca>
${caCert}
</ca>
`;
}

/**
 * Assign VPN configuration to a device
 * 
 * @param deviceUuid - Device UUID
 * @param vpnConfigId - VPN configuration ID (null to use default)
 * @returns Success status
 */
export async function assignVpnConfigToDevice(deviceUuid: string, vpnConfigId: number | null): Promise<boolean> {
  try {
    await query(
      `UPDATE agents 
       SET vpn_config_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE uuid = $2`,
      [vpnConfigId, deviceUuid]
    );
    return true;
  } catch (error) {
    console.error('Error assigning VPN config to device:', error);
    return false;
  }
}

/**
 * Update VPN configuration
 * 
 * @param id - VPN config ID
 * @param updates - Fields to update
 * @returns Updated configuration or null
 */
export async function updateVpnConfig(id: number, updates: Partial<VpnConfig>): Promise<VpnConfig | null> {
  try {
    if (Object.keys(updates).length === 0) {
      return null;
    }
    
    // Update via SystemConfig (throws if not found)
    await SystemConfig.updateVpnConfig(id, updates);
    
    // Retrieve updated config
    const updatedConfig = await SystemConfig.getVpnConfig(id);
    
    return updatedConfig || null;
  } catch (error) {
    console.error('Error updating VPN config:', error);
    return null;
  }
}

/**
 * List all VPN configurations
 * 
 * @param activeOnly - Only return active configurations
 * @returns Array of VPN configurations
 */
export async function listVpnConfigs(activeOnly: boolean = true): Promise<VpnConfig[]> {
  try {
    // Get all VPN configs from SystemConfig
    const configs = await SystemConfig.getAllVpnConfigs();
    
    // Filter by is_active status if requested
    const filteredConfigs = activeOnly 
      ? configs.filter(c => c.is_active) 
      : configs;
    
    // Sort by is_default DESC, name ASC
    return filteredConfigs.sort((a, b) => {
      if (a.is_default && !b.is_default) return -1;
      if (!a.is_default && b.is_default) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
  } catch (error) {
    console.error('Error listing VPN configs:', error);
    return [];
  }
}
