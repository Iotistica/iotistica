/**
 * Provisioning Service
 * 
 * Handles device provisioning business logic including:
 * - Device registration
 * - Key exchange
 * - MQTT credential generation
 * - VPN configuration (if enabled)
 * - Target state initialization
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { query } from '../db/connection';
import {
  DeviceModel,
  DeviceTargetStateModel,
} from '../db/models';
import {
  validateProvisioningKey,
  incrementProvisioningKeyUsage,
} from '../utils/provisioning-keys';
import { wireGuardService } from './wireguard.service';
import {
  logAuditEvent,
  logProvisioningAttempt,
  checkProvisioningRateLimit,
  AuditEventType,
  AuditSeverity
} from '../utils/audit-logger';
import { EventPublisher } from './event-sourcing';
import {
  getBrokerConfigForDevice,
  getBrokerConfigForExternalDevice,
  buildBrokerUrl,
  formatBrokerConfigForClient
} from '../utils/mqtt-broker-config';

import { generateDefaultTargetState } from './default-target-state-generator';
import logger from '../utils/logger';
import { configService }  from './config.service';

// Initialize event publisher for audit trail
const eventPublisher = new EventPublisher();

export interface RegistrationRequest {
  uuid: string;
  deviceName: string;
  deviceType: string;
  deviceApiKey: string;
  provisioningApiKey: string;
  applicationId?: number;
  macAddress?: string;
  osVersion?: string;
  agentVersion?: string;
}

export interface KeyExchangeRequest {
  deviceApiKey: string;
}

export interface ProvisioningResponse {
  id: number;
  uuid: string;
  deviceName: string;
  deviceType: string;
  applicationId?: number;
  fleetId: string;
  createdAt: string;
  mqtt: {
    username: string;
    password: string;
    broker: string;
    brokerConfig?: any;
    topics: {
      publish: string[];
      subscribe: string[];
    };
  };
  api?: {
    tlsConfig: {
      caCert: string;
      verifyCertificate: boolean;
    };
  };
  vpn?: {
    enabled: boolean;
    type: string;
    peer: {
      id: string;
      ipAddress: string;
    };
    server: {
      endpoint: string;
      port: number;
      protocol: string;
    };
    config: string;
  };
}

export class ProvisioningService {
  /**
   * Register a new device
   */
  public async registerDevice(
    data: RegistrationRequest,
    ipAddress?: string,
    userAgent?: string
  ): Promise<ProvisioningResponse> {
    const { uuid, deviceName, deviceType, deviceApiKey, provisioningApiKey, macAddress, osVersion, agentVersion } = data;

    const now = new Date();

    // Rate limiting check (database-backed)
    await checkProvisioningRateLimit(ipAddress!);

    // Validate provisioning key
    const provisioningKeyRecord = await validateProvisioningKey(provisioningApiKey);

    if (!provisioningKeyRecord.valid || !provisioningKeyRecord.keyRecord) {
      await logProvisioningAttempt(ipAddress!, uuid, null, false, provisioningKeyRecord.error || 'Invalid provisioning key', userAgent);
      throw new Error(provisioningKeyRecord.error || 'Invalid provisioning key');
    }

    const keyRecord = provisioningKeyRecord.keyRecord;

    // Check if device already exists and is fully provisioned
    const existingDevice = await DeviceModel.getByUuid(uuid);
    if (existingDevice) {
      const isFullyProvisioned = existingDevice.provisioned_at && existingDevice.provisioning_state === 'registered';
      
      if (isFullyProvisioned) {
        await logProvisioningAttempt(ipAddress!, uuid, keyRecord.id, false, 'Device already registered', userAgent);
        throw new Error('Device already registered');
      }

    }

    const [
      hashedApiKey,
      mqttCredentials,
      vpnCredentials
    ] = await Promise.all([
      bcrypt.hash(deviceApiKey, 10),
      this.generateMqttCredentials(uuid),
      this.generateVpnCredentials(uuid, deviceName, ipAddress)
    ]);

    // Upsert device with all provisioning fields atomically
    const device = await DeviceModel.upsert(uuid, {
      device_name: deviceName,
      device_type: deviceType,
      device_api_key_hash: hashedApiKey,
      fleet_id: keyRecord.fleet_id,
      provisioned_by_key_id: keyRecord.id,
      mac_address: macAddress || null,
      os_version: osVersion || null,
      agent_version: agentVersion || null,
      mqtt_username: mqttCredentials.username,
      vpn_enabled: !!vpnCredentials,
      vpn_ip_address: vpnCredentials?.ipAddress || null,
      is_online: true,
      is_active: true,
      status: 'online',
      provisioned_at: now,
      provisioning_state: 'registered'
    });


    // Create default target state
    this.createDefaultTargetState(uuid).catch(err => console.error('Failed to create default target state', err));

    // Increment provisioning key usage, fire and forget
    incrementProvisioningKeyUsage(keyRecord.id).catch(err => console.error('Failed to increment provisioning key usage', err));

    // fire and forget
    eventPublisher.publish( 'device.provisioned',
      'device',
      uuid,
      {
        device_name: deviceName,
        device_type: deviceType,
        fleet_id: keyRecord.fleet_id,
        provisioned_at: now.toISOString(),
        ip_address: ipAddress,
        mac_address: macAddress,
        os_version: osVersion,
        agent_version: agentVersion,
        mqttUsername: mqttCredentials.username
      }).catch(err => logger.error(err));

     // Audit logging
     logAuditEvent({
      eventType: AuditEventType.DEVICE_REGISTERED,
      deviceUuid: uuid,
      ipAddress,
      userAgent,
      severity: AuditSeverity.INFO,
      details: {
        deviceName,
        macAddress,
        fleetId: keyRecord.fleet_id,
        mqttUsername: mqttCredentials.username
      }
    }).catch(err => logger.error('audit failed', err));

    //Log provisioning attempt
   logProvisioningAttempt(
        ipAddress!,
        uuid,
        keyRecord.id,
        true,
        'Device registered successfully',
        userAgent
   ).catch(err => logger.error('Failed to log successful provisioning', err));


    // Build and return provisioning response
    return this.buildProvisioningResponse(
      device,
      data,
      keyRecord,
      mqttCredentials,
      vpnCredentials
    );
  }

  /**
   * Generate MQTT credentials for device
   */
  private async generateMqttCredentials(deviceUuid: string): Promise<{ username: string; password: string }> {
    const username = `device_${deviceUuid}`;
    const password = crypto.randomBytes(16).toString('base64');
    const passwordHash = await bcrypt.hash(password, 10);

    // Create MQTT user and acls
     await Promise.all([
        query(
          `INSERT INTO mqtt_users (username, password_hash, is_superuser, is_active)
             VALUES ($1, $2, false, true)
             ON CONFLICT (username) DO NOTHING`,
          [username, passwordHash]
        ),
        query(
          `INSERT INTO mqtt_acls (clientid, username, topic, access, priority)
             VALUES ($1, $2, $3, 7, 0)
             ON CONFLICT DO NOTHING`,
          [username, username, `iot/device/${deviceUuid}/#`]
        )
      ]);


    logger.info(`MQTT credentials created for: ${username}`);
    return { username, password };
  }

  /**
   * Generate VPN credentials for device
   */
 private async generateVpnCredentials(
  deviceUuid: string,
  deviceName: string,
  ipAddress?: string
): Promise<{ peerId: string; ipAddress: string; config: string } | undefined> {
  if (!wireGuardService.isEnabled()) return undefined;

  try {
    const peer = await wireGuardService.createPeer(deviceUuid, deviceName);
    logger.info(`WireGuard VPN credentials created for device: ${deviceUuid.substring(0,8)}... (IP: ${peer.ipAddress})`);
    return { peerId: peer.peerId, ipAddress: peer.ipAddress, config: peer.config };
  } catch (error: any) {
    logger.error(`VPN credential creation failed for device ${deviceUuid}: ${error.message}`);
    
    // Fire-and-forget audit log
    logAuditEvent({
      eventType: AuditEventType.PROVISIONING_FAILED,
      deviceUuid,
      ipAddress,
      severity: AuditSeverity.WARNING,
      details: { reason: 'VPN credential creation failed', error: error.message }
    }).catch(err => logger.error('Failed to log VPN provisioning failure', err));

    return undefined;
  }
}

  /**
   * Create default target state for device
   */
  private async createDefaultTargetState(deviceUuid: string): Promise<void> {
    const targetState = await DeviceTargetStateModel.get(deviceUuid);
    if (!targetState) {
      const licenseData = await configService.get('license_data');
      const { apps, config } = generateDefaultTargetState(licenseData);
      await DeviceTargetStateModel.set(deviceUuid, apps, config, false); // Don't need deployment for default state
    }
  }

  /**
   * Build provisioning response
   */
  private async buildProvisioningResponse(
    device: any,
    data: RegistrationRequest,
    provisioningKeyRecord: any,
    mqttCredentials: { username: string; password: string },
    vpnCredentials?: { peerId: string; ipAddress: string; config: string }
  ): Promise<ProvisioningResponse> {
    const { uuid, deviceName, deviceType, applicationId } = data;

    // Fetch broker configuration for external device (uses MQTT_BROKER_EXTERNAL_HOST if set)
    const brokerConfig = await getBrokerConfigForExternalDevice(device.uuid);
    
    if (brokerConfig) {
      logger.info(`Using MQTT broker for external device: ${brokerConfig.name} (${buildBrokerUrl(brokerConfig)})`);
    } else {
      logger.info('No broker config in database, using environment fallback');
    }

    // Build broker URL and config (with credentials)
    let finalBrokerConfig;
    let brokerUrl;
    
    if (brokerConfig) {
      // Use database broker config
      finalBrokerConfig = formatBrokerConfigForClient(brokerConfig, mqttCredentials);
      brokerUrl = buildBrokerUrl(brokerConfig);
    } else {
      // Fallback to environment variables
      const envBrokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
      const parsedUrl = new URL(envBrokerUrl);
      
      finalBrokerConfig = {
        protocol: parsedUrl.protocol.replace(':', ''),
        host: parsedUrl.hostname,
        port: parseInt(parsedUrl.port || '1883', 10),
        username: mqttCredentials.username,
        password: mqttCredentials.password,
        useTls: parsedUrl.protocol === 'mqtts:',
        clientIdPrefix: 'Iotistic',
        keepAlive: 60,
        cleanSession: true,
        reconnectPeriod: 1000,
        connectTimeout: 30000
      };
      brokerUrl = envBrokerUrl;
    }

    // Fetch API TLS configuration
    const apiTlsConfig = await configService.get('api.tls');

    const response: ProvisioningResponse = {
      id: device.id,
      uuid: device.uuid,
      deviceName,
      deviceType,
      applicationId,
      fleetId: provisioningKeyRecord.fleet_id,
      createdAt: device.created_at.toISOString(),
      mqtt: {
        // Legacy fields for backward compatibility (deprecated)
        username: mqttCredentials.username,
        password: mqttCredentials.password,
        broker: brokerUrl,
        // New consolidated config (includes credentials)
        brokerConfig: finalBrokerConfig,
        topics: {
          publish: [`iot/device/${device.uuid}/#`],
          subscribe: [`iot/device/${device.uuid}/#`]
        }
      },
      ...(apiTlsConfig?.caCert && {
        api: {
          tlsConfig: {
            caCert: apiTlsConfig.caCert,
            verifyCertificate: apiTlsConfig.verifyCertificate !== false
          }
        }
      })
    };

    // Add VPN configuration if enabled
    if (vpnCredentials) {
      const vpnServerEndpoint = process.env.VPN_SERVER_ENDPOINT || 'vpn.iotistic.ca';
      const vpnServerPort = parseInt(process.env.VPN_SERVER_PORT || '51820');
      
      response.vpn = {
        enabled: true,
        type: 'wireguard',
        peer: {
          id: vpnCredentials.peerId,
          ipAddress: vpnCredentials.ipAddress
        },
        server: {
          endpoint: vpnServerEndpoint,
          port: vpnServerPort,
          protocol: 'udp'
        },
        config: vpnCredentials.config
      };
      
      logger.info(`WireGuard VPN configuration added to provisioning response (IP: ${vpnCredentials.ipAddress})`);
    }

    return response;
  }
}

export const provisioningService = new ProvisioningService();
