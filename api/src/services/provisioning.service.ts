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
  Device,
} from '../db/models';
import {
  validateProvisioningKey,
  incrementProvisioningKeyUsage,
  createProvisioningKey,
  ProvisioningKey,
} from '../utils/provisioning-keys';
import { tailscaleService } from './tailscale.service';
import {
  logAuditEvent,
  logProvisioningAttempt,
  checkProvisioningRateLimit,
  AuditEventType,
  AuditSeverity
} from '../utils/audit-logger';
import { EventPublisher } from './event-sourcing';
import {
  getBrokerConfigForExternalDevice,
  buildBrokerUrl,
  formatBrokerConfigForClient
} from '../utils/mqtt-broker-config';

import { generateDefaultTargetState } from './default-target-state-generator';
import logger from '../utils/logger';
import { configService }  from './config.service';
import { virtualAgentDeployer } from './virtual-agent-deployer';

// Initialize event publisher for audit trail
const eventPublisher = new EventPublisher();

export interface RegistrationRequest {
  uuid: string;
  deviceName: string;
  deviceType: string;
  deviceApiKey: string;
  devicePublicKey?: string; // Ed25519/P-256 public key for PoP
  provisioningApiKey: string;
  applicationId?: number;
  macAddress?: string;
  osVersion?: string;
  agentVersion?: string;
  // Virtual agent specific fields
  isVirtual?: boolean;
  namespace?: string;
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
  challenge?: string; // PoP challenge (if public key provided)
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
    type: 'wireguard' | 'tailscale';
    peer?: {
      id: string;
      ipAddress: string;
    };
    server?: {
      endpoint: string;
      port: number;
      protocol: string;
    };
    config?: string;
    tailscale?: {
      authKey: string;
      tailnetName: string;
      expiresAt: string;
    };
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
    const { uuid, deviceName, deviceType, deviceApiKey, devicePublicKey, provisioningApiKey, macAddress, osVersion, agentVersion } = data;

    const now = new Date();

    // Rate limiting check (database-backed)
    await checkProvisioningRateLimit(ipAddress!);

    // ============================================================
    // VIRTUAL AGENT PATH (Server-side provisioning key generation)
    // ============================================================
    if (deviceType === 'virtual') {
      logger.info('Processing virtual agent registration', {
        deviceUuid: uuid.substring(0, 8) + '...',
        deviceName,
        deviceType
      });

      // 1. Generate provisioning key server-side
      const fleetId = data.applicationId?.toString() || 'default-fleet';
      const provisioningKeyResult = await createProvisioningKey(
        fleetId,
        1, // max_devices: 1 (one-time use for this specific virtual agent)
        1, // expires_in_days: 1 (short-lived for security)
        `Auto-generated for virtual agent: ${deviceName}`,
        'system' // created_by
      );

      const generatedProvisioningKey = provisioningKeyResult.key;
      const provisioningKeyId = provisioningKeyResult.id;

      logger.info('Provisioning key generated for virtual agent', {
        deviceUuid: uuid.substring(0, 8) + '...',
        provisioningKeyId,
        fleetId
      });

      // 2. Hash device API key
      const hashedApiKey = await bcrypt.hash(deviceApiKey, 10);

      // 3. Create device record (pending deployment)
      const deviceData: Partial<Device> = {
        device_name: deviceName,
        device_type: 'virtual',
        device_api_key_hash: hashedApiKey,
        fleet_id: fleetId,
        provisioned_by_key_id: provisioningKeyId,
        mac_address: macAddress || null,
        os_version: osVersion || null,
        agent_version: agentVersion || null,
        deployment_status: 'pending',
        k8s_namespace: (data as any).namespace || process.env.VIRTUAL_AGENT_NAMESPACE || 'virtual-agents',
        is_online: false, // Not online yet (pod not running)
        is_active: true,
        status: 'deploying',
        provisioned_at: null, // Will be set when agent self-provisions
        provisioning_state: 'pending'
      };

      // Upsert device
      const device = await DeviceModel.upsert(uuid, deviceData);

      logger.info('Virtual agent device record created', {
        deviceId: device.id,
        deviceUuid: uuid.substring(0, 8) + '...',
        deploymentStatus: 'pending'
      });

      // 4. Create default target state (needed for when pod comes online)
      await this.createDefaultTargetState(uuid, agentVersion, provisioningKeyId);

      // 5. Deploy to K8s with plaintext provisioning key
      try {
        await virtualAgentDeployer.deploy({
          deviceUuid: device.uuid,
          deviceName: device.device_name,
          provisioningKey: generatedProvisioningKey, // Plaintext, injected to K8s Secret
          fleetId: device.fleet_id,
          namespace: device.k8s_namespace || undefined
        });

        logger.info('Virtual agent deployment initiated', {
          deviceUuid: uuid.substring(0, 8) + '...',
          namespace: device.k8s_namespace
        });
      } catch (deployError) {
        logger.error('Virtual agent deployment failed', {
          deviceUuid: uuid,
          error: deployError instanceof Error ? deployError.message : String(deployError)
        });

        // Update device status to failed
        await DeviceModel.update(device.uuid, {
          deployment_status: 'failed',
          status: 'offline'
        });

        throw new Error(`Virtual agent deployment failed: ${deployError instanceof Error ? deployError.message : String(deployError)}`);
      }

      // 6. Audit logging
      await logAuditEvent({
        eventType: AuditEventType.DEVICE_REGISTERED,
        deviceUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.INFO,
        details: {
          deviceName,
          deviceType: 'virtual',
          fleetId,
          namespace: device.k8s_namespace,
          deploymentStatus: 'deploying'
        }
      }).catch(err => logger.error('audit failed', err));

      // 7. Event publishing
      await eventPublisher.publish(
        'device.virtual-agent.deployed',
        'device',
        uuid,
        {
          device_name: deviceName,
          device_type: 'virtual',
          fleet_id: fleetId,
          namespace: device.k8s_namespace,
          created_at: now.toISOString()
        }
      ).catch(err => logger.error('event publish failed', err));

      // 8. Return minimal response (NO provisioning key sent to client!)
      return {
        id: device.id,
        uuid: device.uuid,
        deviceName: device.device_name,
        deviceType: device.device_type,
        fleetId: device.fleet_id,
        createdAt: device.created_at.toISOString(),
        mqtt: {
          username: '',
          password: '',
          broker: '',
          topics: {
            publish: [],
            subscribe: []
          }
        }
      } as any; // Minimal response for virtual agents
    }

    // ============================================================
    // VIRTUAL AGENT PATH (Device pre-created by dashboard)
    // ============================================================
    
    // Check if device already exists - critical for virtual agents
    const existingDevice = await DeviceModel.getByUuid(uuid);
    
    // Identify virtual agents by EITHER device_type='virtual' OR deployment_status is set
    const isVirtualAgent = existingDevice && 
                           (existingDevice.device_type === 'virtual' || !!existingDevice.deployment_status);
    
    if (isVirtualAgent) {
      logger.info('Virtual agent registration detected - using existing device record', {
        deviceUuid: uuid.substring(0, 8) + '...',
        existingName: existingDevice.device_name,
        existingType: existingDevice.device_type,
        agentProvidedName: deviceName,
        deploymentStatus: existingDevice.deployment_status,
        provisioningState: existingDevice.provisioning_state
      });
      
      // Validate provisioning key matches
      if (!existingDevice.provisioned_by_key_id) {
        throw new Error('Virtual agent missing provisioning key association');
      }
      
      const existingKeyRecord = await query<ProvisioningKey>(
        `SELECT * FROM provisioning_keys WHERE id = $1`,
        [existingDevice.provisioned_by_key_id]
      );
      
      if (existingKeyRecord.rows.length === 0) {
        throw new Error('Provisioning key not found for virtual agent');
      }
      
      const keyMatches = await bcrypt.compare(provisioningApiKey, existingKeyRecord.rows[0].key_hash);
      if (!keyMatches) {
        await logProvisioningAttempt(ipAddress!, uuid, existingDevice.provisioned_by_key_id, false, 'Provisioning key mismatch', userAgent);
        throw new Error('Provisioning key does not match device record');
      }
      
      const keyRecord = existingKeyRecord.rows[0];
      
      // Generate credentials
      const [hashedApiKey, mqttCredentials, vpnCredentials] = await Promise.all([
        bcrypt.hash(deviceApiKey, 10),
        this.generateMqttCredentials(uuid),
        this.generateVpnCredentials(uuid, existingDevice.device_name, ipAddress)
      ]);
      
      // Update ONLY registration fields - preserve dashboard-created name, type, fleet, etc.
      const deviceData: Partial<Device> = {
        device_api_key_hash: hashedApiKey,
        mqtt_username: mqttCredentials.username,
        vpn_enabled: !!vpnCredentials,
        vpn_ip_address: null,
        mac_address: macAddress || null,
        os_version: osVersion || null,
        agent_version: agentVersion || null,
        is_online: true,
        is_active: true,
        status: 'online',
        provisioned_at: now,
        provisioning_state: 'registered'
      };
      
      if (devicePublicKey) {
        deviceData.device_public_key = devicePublicKey;
        deviceData.pop_verified = false;
      }
      
      const device = await DeviceModel.upsert(uuid, deviceData);
      
      logger.info('Virtual agent registered successfully', {
        deviceId: device.id,
        deviceUuid: uuid.substring(0, 8) + '...',
        deviceName: device.device_name,
        deviceType: device.device_type
      });
      
      await this.createDefaultTargetState(uuid, agentVersion, keyRecord.id);
      await logProvisioningAttempt(ipAddress!, uuid, keyRecord.id, true, null, userAgent);
      
      // Generate PoP challenge if public key was provided
      let challenge: string | undefined;
      if (devicePublicKey) {
        challenge = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        await DeviceModel.storeChallenge(uuid, challenge, expiresAt);
      }
      
      // Use same response builder as physical agents
      return this.buildProvisioningResponse(
        device,
        data,
        keyRecord,
        mqttCredentials,
        vpnCredentials,
        challenge
      );
    }
    
    // ============================================================
    // PHYSICAL AGENT PATH (New device or existing physical device)
    // ============================================================
    
    if (existingDevice) {
      const isFullyProvisioned = existingDevice.provisioned_at && existingDevice.provisioning_state === 'registered';
      
      if (isFullyProvisioned) {
        await logProvisioningAttempt(ipAddress!, uuid, existingDevice.provisioned_by_key_id || null, false, 'Device already registered', userAgent);
        throw new Error('Device already registered');
      }
      
      // Use existing provisioning key if present
      if (existingDevice.provisioned_by_key_id) {
        const existingKeyRecord = await query<ProvisioningKey>(
          `SELECT * FROM provisioning_keys WHERE id = $1`,
          [existingDevice.provisioned_by_key_id]
        );
        
        if (existingKeyRecord.rows.length === 0) {
          throw new Error('Existing provisioning key not found');
        }
        
        const keyMatches = await bcrypt.compare(provisioningApiKey, existingKeyRecord.rows[0].key_hash);
        if (!keyMatches) {
          await logProvisioningAttempt(ipAddress!, uuid, existingDevice.provisioned_by_key_id, false, 'Provisioning key mismatch', userAgent);
          throw new Error('Provisioning key does not match device record');
        }
        
        var keyRecord = existingKeyRecord.rows[0];
      }
    }
    
    // Validate provisioning key if not already validated
    if (!existingDevice || !existingDevice.provisioned_by_key_id) {
      const provisioningKeyRecord = await validateProvisioningKey(provisioningApiKey);

      if (!provisioningKeyRecord.valid || !provisioningKeyRecord.keyRecord) {
        await logProvisioningAttempt(ipAddress!, uuid, null, false, provisioningKeyRecord.error || 'Invalid provisioning key', userAgent);
        throw new Error(provisioningKeyRecord.error || 'Invalid provisioning key');
      }

      var keyRecord = provisioningKeyRecord.keyRecord;
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

    // Prepare device data for physical agents
    const deviceData: Partial<Device> = {
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
      vpn_ip_address: null,
      is_online: true,
      is_active: true,
      status: 'online',
      provisioned_at: now,
      provisioning_state: 'registered'
    };

    if (devicePublicKey) {
      logger.info('Device registration includes public key for PoP', {
        deviceUuid: uuid.substring(0, 8) + '...',
        deviceName,
        publicKeyLength: devicePublicKey.length
      });
      deviceData.device_public_key = devicePublicKey;
      deviceData.pop_verified = false;
    } else {
      logger.warn('⚠️ Device registered without public key - using LEGACY authentication', {
        deviceUuid: uuid.substring(0, 8) + '...',
        deviceName
      });
    }

    const device = await DeviceModel.upsert(uuid, deviceData);
    
    logger.info('Device upserted to database', {
      deviceId: device.id,
      deviceUuid: uuid.substring(0, 8) + '...',
      hasPublicKey: !!devicePublicKey,
      popVerified: device.pop_verified
    });

    await this.createDefaultTargetState(uuid, agentVersion, keyRecord.id);

    // Increment provisioning key usage for new physical devices
    if (!existingDevice || !existingDevice.provisioned_by_key_id) {
      incrementProvisioningKeyUsage(keyRecord.id).catch(err => console.error('Failed to increment provisioning key usage', err));
    }

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

    // Generate PoP challenge if public key was provided
    let challenge: string | undefined;
    if (devicePublicKey) {
      challenge = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
      
      logger.info('Generating PoP challenge for device', {
        deviceUuid: uuid.substring(0, 8) + '...',
        challengeLength: challenge.length,
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: 300
      });
      
      await DeviceModel.storeChallenge(uuid, challenge, expiresAt);
      
      logger.info('PoP challenge stored in database', {
        deviceUuid: uuid.substring(0, 8) + '...',
        expiresAt: expiresAt.toISOString()
      });
    } else {
      logger.info('No PoP challenge generated (no public key provided)', {
        deviceUuid: uuid.substring(0, 8) + '...'
      });
    }

    // Build and return provisioning response
    return this.buildProvisioningResponse(
      device,
      data,
      keyRecord,
      mqttCredentials,
      vpnCredentials,
      challenge
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
   * Generate Tailscale VPN credentials for device
   */
  private async generateVpnCredentials(
    deviceUuid: string,
    deviceName: string,
    ipAddress?: string
  ): Promise<{ type: 'tailscale'; tailscale: any } | undefined> {
  logger.info(`Generating Tailscale VPN credentials for device: ${deviceUuid.substring(0,8)}...`, {
    deviceUuid,
    deviceName,
    tailscaleEnabled: tailscaleService.isEnabled()
  });
  
  // Use Tailscale VPN (only option)
  if (!tailscaleService.isEnabled()) {
    logger.warn(`Tailscale VPN is not enabled - device ${deviceUuid.substring(0,8)}... will provision without VPN`);
    return undefined;
  }

  try {
    // Use default IoT security options from tailscaleService (ephemeral, 30min expiry, shields up)
    const tailscaleCredentials = await tailscaleService.createAuthKey(
      deviceUuid,
      deviceName
      // No options = use secure defaults from tailscaleService
    );
    logger.info(`Tailscale VPN credentials created for device: ${deviceUuid.substring(0,8)}...`, {
      deviceUuid,
      deviceName,
      authKey: tailscaleCredentials.authKey ? `${tailscaleCredentials.authKey.substring(0, 20)}...` : 'none',
      tailnetName: tailscaleCredentials.tailnetName,
      shieldsUp: tailscaleCredentials.shieldsUp,
      acceptRoutes: tailscaleCredentials.acceptRoutes,
      acceptDNS: tailscaleCredentials.acceptDNS,
    });
    return { 
      type: 'tailscale',
      tailscale: tailscaleCredentials
    };
  } catch (error: any) {
    logger.error(`Tailscale credential creation failed for device ${deviceUuid}: ${error.message}`);
    
    // Fire-and-forget audit log
    logAuditEvent({
      eventType: AuditEventType.PROVISIONING_FAILED,
      deviceUuid,
      ipAddress,
      severity: AuditSeverity.WARNING,
      details: { reason: 'Tailscale credential creation failed', error: error.message }
    }).catch(err => logger.error('Failed to log Tailscale provisioning failure', err));
    
    return undefined;
  }
}

  /**
   * Create default target state for device
   */
  private async createDefaultTargetState(deviceUuid: string, agentVersion?: string, provisioningKeyId?: string): Promise<void> {
    const targetState = await DeviceTargetStateModel.get(deviceUuid);
    if (!targetState) {
      const licenseData = await configService.get('license_data');
      
      // Fetch simulator config from provisioning key if available
      let simulatorOptions = undefined;
      if (provisioningKeyId) {
        try {
          const keyResult = await query(
            'SELECT deployment_type, simulator_config, metadata FROM provisioning_keys WHERE id = $1',
            [provisioningKeyId]
          );
          
          if (keyResult.rows.length > 0 && keyResult.rows[0].simulator_config) {
            const { deployment_type, simulator_config } = keyResult.rows[0];
            simulatorOptions = {
              deploymentType: deployment_type,
              simulatorConfig: simulator_config
            };
            logger.info('Using simulator config from provisioning key for target state generation', {
              deviceUuid,
              deploymentType: deployment_type,
              simulatorConfig: simulator_config
            });
          }
        } catch (error: any) {
          logger.warn('Failed to fetch simulator config from provisioning key', {
            error: error.message,
            provisioningKeyId
          });
          // Non-fatal - continue with default config
        }
      }
      
      // Single source of truth for target state generation
      const { apps, config } = await generateDefaultTargetState(licenseData, simulatorOptions);
      
      // Get required agent version from cloud policy (system_config)
      const requiredAgentVersion = await configService.get('required_agent_version');
      
      // Set target version to cloud's required version (not agent's current)
      // This enables immediate reconciliation if agent is outdated
      config.agent = {
        version: requiredAgentVersion || agentVersion || 'latest',
        // No signature needed - this is policy, not an update command
      };
      
      // Log warning if agent doesn't match required version
      if (requiredAgentVersion && agentVersion && requiredAgentVersion !== agentVersion) {
        logger.warn('Agent version mismatch at provisioning', {
          deviceUuid,
          agentVersion,
          requiredVersion: requiredAgentVersion,
          action: 'will_auto_update_on_first_poll'
        });
      }
      
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
    vpnCredentials?: { type: 'tailscale'; tailscale: any },
    challenge?: string
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
      ...(challenge && { challenge }), // Include challenge if PoP enabled
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

    // Add Tailscale VPN configuration if credentials were generated
    if (vpnCredentials) {
      response.vpn = {
        enabled: true,
        type: 'tailscale',
        tailscale: vpnCredentials.tailscale
      };
      logger.info(`Tailscale VPN configuration added to provisioning response`, {
        deviceUuid: device.uuid,
        vpnType: 'tailscale',
        hasAuthKey: !!vpnCredentials.tailscale?.authKey,
        tailnetName: vpnCredentials.tailscale?.tailnetName,
        expiresAt: vpnCredentials.tailscale?.expiresAt
      });
    }

    return response;
  }
}

export const provisioningService = new ProvisioningService();
