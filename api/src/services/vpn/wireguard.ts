import { fetch } from 'undici';
import logger from '../../utils/logger';

interface WireGuardPeerResponse {
  peerId: string;
  publicKey: string;
  ipAddress: string;
  deviceId: string;
  deviceName: string;
  createdAt: string;
}

interface WireGuardCredentials {
  peerId: string;
  ipAddress: string;
  config: string;
}

/**
 * WireGuard VPN Service
 * Manages VPN peer creation and configuration for device provisioning
 */
export class WireGuardService {
  private wgServerUrl: string;
  private serverEndpoint: string;
  private enabled: boolean;

  constructor() {
    this.enabled = process.env.VPN_ENABLED === 'true';
    this.wgServerUrl = process.env.WG_SERVER_URL || 'http://wg-server:8089';
    this.serverEndpoint = process.env.VPN_SERVER_ENDPOINT || 'vpn.example.com';
    
    if (this.enabled) {
      logger.info(`WireGuard VPN enabled - Server: ${this.wgServerUrl}, Endpoint: ${this.serverEndpoint}`);
    }
  }

  /**
   * Check if WireGuard VPN is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Create WireGuard peer for device
   */
  async createPeer(deviceUuid: string, deviceName: string): Promise<WireGuardCredentials> {
    if (!this.enabled) {
      throw new Error('WireGuard VPN is not enabled');
    }

    try {
      logger.info(`Creating WireGuard peer for device: ${deviceUuid}`);

      // Create peer via wg-server API
      const response = await fetch(`${this.wgServerUrl}/api/peers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: deviceUuid,
          deviceName: deviceName || `Device ${deviceUuid.substring(0, 8)}`,
          notes: `Auto-provisioned on ${new Date().toISOString()}`
        })
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`WireGuard peer creation failed: ${response.status} ${error}`);
      }

      const peer: WireGuardPeerResponse = await response.json() as WireGuardPeerResponse;

      // Fetch peer configuration
      const configResponse = await fetch(`${this.wgServerUrl}/api/peers/${peer.peerId}/config`);
      
      if (!configResponse.ok) {
        throw new Error(`Failed to fetch peer config: ${configResponse.statusText}`);
      }

      const config = await configResponse.text();

      logger.info(`WireGuard peer created: ${peer.peerId} (IP: ${peer.ipAddress})`);

      return {
        peerId: peer.peerId,
        ipAddress: peer.ipAddress,
        config: config
      };
    } catch (error: any) {
      logger.error(`Failed to create WireGuard peer:`, error);
      throw new Error(`WireGuard setup failed: ${error.message}`);
    }
  }

  /**
   * Delete WireGuard peer for device
   */
  async deletePeer(peerId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    try {
      logger.info(`Deleting WireGuard peer: ${peerId}`);

      const response = await fetch(`${this.wgServerUrl}/api/peers/${peerId}`, {
        method: 'DELETE'
      });

      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete peer: ${response.statusText}`);
      }

      logger.info(`WireGuard peer deleted: ${peerId}`);
    } catch (error: any) {
      logger.error(`Failed to delete WireGuard peer:`, error);
      // Don't throw - peer deletion is not critical
    }
  }

  /**
   * Get QR code for device (useful for mobile provisioning)
   */
  async getPeerQRCode(peerId: string): Promise<Buffer> {
    if (!this.enabled) {
      throw new Error('WireGuard VPN is not enabled');
    }

    try {
      const response = await fetch(`${this.wgServerUrl}/api/peers/${peerId}/qr`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch QR code: ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      return buffer;
    } catch (error: any) {
      logger.error(`Failed to fetch QR code:`, error);
      throw error;
    }
  }

  /**
   * Check WireGuard server health
   */
  async checkHealth(): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }

    try {
      const response = await fetch(`${this.wgServerUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}

// Singleton instance
export const wireGuardService = new WireGuardService();
