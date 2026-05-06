/**
 * Types for agent provisioning in standalone container-manager
 * Implements two-phase authentication similar to Balena Supervisor
 */

/**
 * Provisioning state machine
 */
export type ProvisioningState = 'new' | 'registering' | 'registered' | 'key-exchanging' | 'provisioned';

export interface AgentInfo {
	uuid: string;
	name?: string;
	type?: string;
	
	// Two-phase authentication keys
	apiKey?: string;              // Agent API key (permanent)
	provisioningApiKey?: string;  // Fleet/provisioning key (temporary)
	
	apiEndpoint?: string;
	registeredAt?: number;
	provisioned: boolean;
	popVerified?: boolean;        // True if provisioned via PoP (enables PoP-only features)
	
	// Provisioning state machine
	provisioningState?: ProvisioningState;
	
	// VPN configuration
	vpnEnabled?: boolean;         // True if agent was provisioned with VPN credentials
	
	// Additional metadata
	tenantId?: string;            // Tenant ID for MQTT topic construction
	applicationId?: number;       // Deprecated: for backward compatibility
	macAddress?: string;
	osVersion?: string;
	agentVersion?: string;
	mqttBrokerConfig?: MqttBrokerConfig; // TLS configuration from provisioning
	apiTlsConfig?: ApiTlsConfig;         // API HTTPS TLS configuration
}

export interface MqttBrokerConfig {
	protocol: string;           // 'mqtt' or 'mqtts'
	host: string;
	port: number;
	username?: string;          // MQTT username
	password?: string;          // MQTT password
	useTls: boolean;
	caCert?: string;            // CA certificate (PEM format)
	clientCert?: string;        // Client certificate (optional)
	verifyCertificate: boolean;
	clientIdPrefix: string;
	keepAlive: number;
	cleanSession: boolean;
	reconnectPeriod: number;
	connectTimeout: number;
}

export interface ApiTlsConfig {
	caCert?: string;             // CA certificate for HTTPS (PEM format)
	clientCert?: string;         // Client certificate (optional, for mTLS)
	verifyCertificate: boolean;  // Whether to verify server certificate
}

export interface ProvisioningConfig {
	uuid?: string;
	name?: string;
	type?: string;
	apiEndpoint?: string;
	
	// Two-phase auth
	provisioningApiKey: string;   // Required: fleet-level key
	deviceApiKey?: string;         // Optional: if not provided, will be generated
	
	// Fleet configuration
	applicationId?: number;
	
	// Agent metadata
	macAddress?: string;
	osVersion?: string;
	agentVersion?: string;
}

export interface ProvisionRequest {
	uuid: string;
	name: string;
	type: string;
	agentApiKey: string;          // Pre-generated agent key
	agentPublicKey?: string;      // Ed25519 public key for PoP (PEM format)
	applicationId?: number;
	macAddress?: string;
	osVersion?: string;
	agentVersion?: string;
}

export interface ProvisionResponse {
	id: number;                    // Server-assigned agent ID
	uuid: string;
	name: string;
	type: string;
	tenantId?: string;             // Tenant ID for MQTT topic construction
	applicationId?: number;        // Deprecated: for backward compatibility only
	challenge?: string;            // Server nonce for proof-of-possession
	mqtt: {
		username: string,
		password: string,
		broker: string,
		brokerConfig?: MqttBrokerConfig, // TLS and connection configuration
		topics: {
			publish: string,
			subscribe: string
		}
	}
	api?: {
		tlsConfig?: ApiTlsConfig;  // API HTTPS TLS configuration
	}
	vpn?: 
		| {
				enabled: boolean;
				type: 'wireguard';
				peer?: {
					id: string;
					ipAddress: string;
				};
				server?: {
					endpoint: string;
					port: number;
					protocol: string;
				};
				config?: string;  // Complete WireGuard config file content
		  }
		| {
				enabled: boolean;
				type: 'tailscale';
				tailscale: {
					authKey: string;
					tailnetName: string;
					expiresAt: string;
					shieldsUp?: boolean;      // Block all inbound traffic (IoT security)
					acceptRoutes?: boolean;   // Accept subnet routes (routers/gateways only)
					acceptDNS?: boolean;      // Use Tailscale MagicDNS
				};
		  }
	createdAt: string;
}

export interface KeyExchangeRequest {
	uuid: string;
	deviceApiKey?: string;  // Optional: only sent in bcrypt fallback mode, NOT in PoP mode
	challenge?: string;     // Server nonce for proof-of-possession (legacy)
	proof?: string;         // HMAC-SHA256 proof (computed from challenge, legacy)
	signature?: string;     // Ed25519 signature for PoP (base64-encoded)
}

export interface KeyExchangeResponse {
	status: 'ok' | 'error';
	message: string;
	device?: {
		id: number;
		uuid: string;
		deviceName: string;
	};
}
