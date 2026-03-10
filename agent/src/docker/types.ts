/**
 * Common Type Definitions
 */

export type LabelObject = Record<string, string>;

/**
 * Network Type Definitions
 */

export interface ComposeNetworkConfig {
  driver?: string;
  driver_opts?: Record<string, string>;
  enable_ipv6?: boolean;
  internal?: boolean;
  ipam?: {
    driver?: string;
    config?: Array<{
      subnet?: string;
      gateway?: string;
      ip_range?: string;
      aux_addresses?: Record<string, string>;
    }>;
    options?: Record<string, string>;
  };
  labels?: Record<string, string>;
  config_only?: boolean;
}

export interface NetworkConfig {
  driver: string;
  ipam: {
    driver: string;
    config: Array<{
      subnet?: string;
      gateway?: string;
      ipRange?: string;
      auxAddress?: Record<string, string>;
    }>;
    options: Record<string, string>;
  };
  enableIPv6: boolean;
  internal: boolean;
  labels: Record<string, string>;
  options: Record<string, string>;
  configOnly: boolean;
}

export interface NetworkInspectInfo {
  Name: string;
  Id: string;
  Driver: string;
  EnableIPv6: boolean;
  IPAM: {
    Driver: string;
    Config: Array<{
      Subnet?: string;
      Gateway?: string;
      IPRange?: string;
      AuxAddress?: Record<string, string>;
    }>;
    Options?: Record<string, string>;
  };
  Internal: boolean;
  Options: Record<string, string>;
  Labels: Record<string, string>;
  ConfigOnly: boolean;
}

export interface Network {
  appId: number;
  appUuid?: string;
  name: string;
  config: NetworkConfig;
  
  // Methods
  create(): Promise<void>;
  remove(): Promise<void>;
  isEqualConfig(network: Network): boolean;
  toComposeObject(): ComposeNetworkConfig;
  toDockerConfig(): any;
}

/**
 * Volume Type Definitions
 */

export interface ComposeVolumeConfig {
  driver?: string;
  driver_opts?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface VolumeConfig {
  driver: string;
  driverOpts?: Record<string, string>;
  labels: Record<string, string>;
}

export interface Volume {
  name: string;
  appId: number;
  appUuid: string;
  config: VolumeConfig;
  
  // Methods
  create(): Promise<void>;
  remove(): Promise<void>;
  isEqualConfig(volume: Volume): boolean;
  toComposeObject(): ComposeVolumeConfig;
}
