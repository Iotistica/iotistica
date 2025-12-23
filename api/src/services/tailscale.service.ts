import fetch from 'node-fetch';
import logger from '../utils/logger';

interface TailscaleAuthKey {
  id: string;
  key: string;
  created: string;
  expires: string;
  capabilities: {
    devices: {
      create: {
        reusable: boolean;
        ephemeral: boolean;
        preauthorized: boolean;
        tags: string[];
      };
    };
  };
}

interface TailscaleDevice {
  id: string;
  nodeId: string;
  name: string;
  hostname: string;
  addresses: string[];
  user: string;
  created: string;
  lastSeen: string;
  os: string;
  tags: string[];
}

interface TailscaleCredentials {
  authKey: string;
  tailnetName: string;
  expiresAt: string;
  shieldsUp: boolean;      // Block all inbound traffic by default (IoT security)
  acceptRoutes: boolean;   // Accept subnet routes from other nodes (false for edge devices)
  acceptDNS: boolean;      // Use Tailscale DNS (false unless MagicDNS needed)
}

/**
 * Tailscale VPN Service
 * Manages Tailscale auth key generation and device management
 * 
 * Documentation: https://tailscale.com/api
 */
export class TailscaleService {
  private apiKey: string;
  private tailnet: string;
  private enabled: boolean;
  private baseUrl = 'https://api.tailscale.com/api/v2';

  constructor() {
    this.enabled = process.env.TAILSCALE_ENABLED === 'true';
    this.apiKey = process.env.TAILSCALE_API_KEY || '';
    this.tailnet = process.env.TAILSCALE_TAILNET || '';
    
    if (this.enabled) {
      if (!this.apiKey) {
        logger.error('Tailscale enabled but TAILSCALE_API_KEY not set');
        this.enabled = false;
      }
      if (!this.tailnet) {
        logger.error('Tailscale enabled but TAILSCALE_TAILNET not set (e.g., example.com or user@example.com)');
        this.enabled = false;
      }
      
      if (this.enabled) {
        logger.info(`Tailscale VPN enabled - Tailnet: ${this.tailnet}`);
      }
    }
  }

  /**
   * Check if Tailscale VPN is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Create Tailscale auth key for device
   * 
   * @param deviceUuid - Device UUID
   * @param deviceName - Device name (used for tagging)
   * @param options - Auth key options
   * @returns Tailscale credentials including auth key
   */
  async createAuthKey(
    deviceUuid: string,
    deviceName: string,
    options: {
      reusable?: boolean;
      ephemeral?: boolean;
      preauthorized?: boolean;
      expiryDays?: number;
      tags?: string[];
    } = {}
  ): Promise<TailscaleCredentials> {
    if (!this.enabled) {
      throw new Error('Tailscale VPN is not enabled');
    }

    try {
      logger.info(`Creating Tailscale auth key for device: ${deviceUuid}`);

      // Default options for IoT devices
      const {
        reusable = false,        // One-time use (more secure)
        ephemeral = true,        // Ephemeral device (removed on disconnect)
        preauthorized = true,    // Auto-approve device
        expiryDays = 1,          // 1 day expiry (reasonable for provisioning)
        tags = []                // Device tags for ACLs
      } = options;

      // Note: Tags must be defined in Tailscale ACL policy before use
      // For now, we'll use empty tags to avoid permission errors
      const deviceTags: string[] = [];

      // Calculate expiry timestamp
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expiryDays);

      // Create auth key via Tailscale API
      const response = await fetch(
        `${this.baseUrl}/tailnet/${this.tailnet}/keys`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            capabilities: {
              devices: {
                create: {
                  reusable,
                  ephemeral,
                  preauthorized,
                  tags: deviceTags
                }
              }
            },
            expirySeconds: expiryDays * 24 * 60 * 60,
            description: `IoT Device ${deviceName} ${deviceUuid.substring(0, 8)}`
          })
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Tailscale auth key creation failed: ${response.status} ${error}`);
      }

      const authKeyData: TailscaleAuthKey = await response.json() as TailscaleAuthKey;

      logger.info(`Tailscale auth key created: ${authKeyData.id}`);

      return {
        authKey: authKeyData.key,
        tailnetName: this.tailnet,
        expiresAt: authKeyData.expires,
        shieldsUp: true,      // Block ALL inbound traffic (IoT security best practice)
        acceptRoutes: false,  // NEVER accept routes for edge devices (only for routers/gateways)
        acceptDNS: false,     // Don't hijack DNS unless MagicDNS needed (can break embedded workloads)
      };
    } catch (error: any) {
      logger.error(`Failed to create Tailscale auth key:`, error);
      throw new Error(`Tailscale setup failed: ${error.message}`);
    }
  }

  /**
   * List devices in Tailnet
   */
  async listDevices(): Promise<TailscaleDevice[]> {
    if (!this.enabled) {
      throw new Error('Tailscale VPN is not enabled');
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/tailnet/${this.tailnet}/devices`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to list devices: ${response.statusText}`);
      }

      const data = await response.json() as { devices: TailscaleDevice[] };
      return data.devices || [];
    } catch (error: any) {
      logger.error(`Failed to list Tailscale devices:`, error);
      throw error;
    }
  }

  /**
   * Get device by ID
   */
  async getDevice(deviceId: string): Promise<TailscaleDevice | null> {
    if (!this.enabled) {
      throw new Error('Tailscale VPN is not enabled');
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/device/${deviceId}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
          }
        }
      );

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`Failed to get device: ${response.statusText}`);
      }

      return await response.json() as TailscaleDevice;
    } catch (error: any) {
      logger.error(`Failed to get Tailscale device:`, error);
      throw error;
    }
  }

  /**
   * Delete device from Tailnet
   */
  async deleteDevice(deviceId: string): Promise<void> {
    if (!this.enabled) {
      throw new Error('Tailscale VPN is not enabled');
    }

    try {
      logger.info(`Deleting Tailscale device: ${deviceId}`);

      const response = await fetch(
        `${this.baseUrl}/device/${deviceId}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
          }
        }
      );

      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete device: ${response.statusText}`);
      }

      logger.info(`Tailscale device deleted: ${deviceId}`);
    } catch (error: any) {
      logger.error(`Failed to delete Tailscale device:`, error);
      throw error;
    }
  }

  /**
   * Revoke auth key (if reusable key needs to be disabled)
   */
  async revokeAuthKey(keyId: string): Promise<void> {
    if (!this.enabled) {
      throw new Error('Tailscale VPN is not enabled');
    }

    try {
      logger.info(`Revoking Tailscale auth key: ${keyId}`);

      const response = await fetch(
        `${this.baseUrl}/tailnet/${this.tailnet}/keys/${keyId}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
          }
        }
      );

      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to revoke auth key: ${response.statusText}`);
      }

      logger.info(`Tailscale auth key revoked: ${keyId}`);
    } catch (error: any) {
      logger.error(`Failed to revoke Tailscale auth key:`, error);
      throw error;
    }
  }
}

// Export singleton instance
export const tailscaleService = new TailscaleService();
