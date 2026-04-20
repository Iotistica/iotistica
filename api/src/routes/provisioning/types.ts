export interface CreateProvisioningKeyBody {
  fleetUuid?: string;
  maxDevices?: number;
  expiresInDays?: number;
  description?: string;
}

export interface ListProvisioningKeysQuerystring {
  fleetUuid?: string;
}

export interface ProvisioningKeyParams {
  keyId: string;
}

export interface RevokeProvisioningKeyBody {
  reason?: string;
}

export interface GenerateProvisioningKeyBody {
  fleetUuid?: string;
  newKey?: boolean;
  previousKeyId?: string;
  deploymentType?: string;
  metadata?: Record<string, unknown>;
  simulatorConfig?: unknown;
}

export interface DeviceUuidParams {
  uuid: string;
}

export interface RegisterDeviceBody {
  uuid?: string;
  deviceName?: string;
  deviceType?: string;
  deviceApiKey?: string;
  devicePublicKey?: string;
  macAddress?: string;
  osVersion?: string;
  agentVersion?: string;
}

export interface KeyExchangeBody {
  deviceApiKey?: string;
  signature?: string;
}
