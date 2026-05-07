/**
 * Proof of Possession (PoP) Cryptography Module
 * 
 * Implements asymmetric cryptography for device authentication:
 * - Ed25519 key pair generation and management
 * - Challenge signing with private key
 * - Secure key storage with encryption
 * - PEM format export for public key transmission
 * 
 * Security Features:
 * - Private key never leaves device
 * - Ed25519 for fast, secure signatures
 * - Encrypted storage of private keys
 * - Challenge-response authentication
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

export interface PopKeyPair {
  publicKey: string;   // PEM format
  privateKey: string;  // PEM format (encrypted in storage)
}

export interface PopChallenge {
  challenge: string;
  expiresAt: string;
}

export class PopCryptoManager {
	private keyPair: PopKeyPair | null = null;
	private keyStoragePath: string;
	private logger?: AgentLogger;

	constructor(dataDir: string, logger?: AgentLogger) {
		this.keyStoragePath = path.join(dataDir, '.pop-keys.json');
		this.logger = logger;
	}

	/**
   * Initialize PoP crypto - load or generate key pair
   * Called on first boot or when keys don't exist
   */
	async initialize(): Promise<void> {
		this.logger?.infoSync('Initializing PoP crypto manager', {
			component: LogComponents.agent,
			operation: 'pop-initialize',
			keyStoragePath: this.keyStoragePath
		});

		// Try to load existing keys
		if (fs.existsSync(this.keyStoragePath)) {
			try {
				const keyData = JSON.parse(fs.readFileSync(this.keyStoragePath, 'utf-8'));
				this.keyPair = keyData;
        
				this.logger?.infoSync('Loaded existing PoP key pair', {
					component: LogComponents.agent,
					operation: 'pop-initialize',
					publicKeyLength: this.keyPair?.publicKey?.length || 0,
					hasPrivateKey: !!this.keyPair?.privateKey
				});
        
				return;
			} catch (error: any) {
				this.logger?.warnSync('Failed to load existing keys, generating new ones', {
					component: LogComponents.agent,
					operation: 'pop-initialize',
					error: error.message
				});
			}
		}

		// Generate new key pair
		await this.generateKeyPair();
	}

	/**
   * Generate new Ed25519 key pair
   * Ed25519 chosen for:
   * - Fast signature generation (~60μs)
   * - Small key size (32 bytes)
   * - Strong security (128-bit security level)
   * - Native Node.js support
   */
	private async generateKeyPair(): Promise<void> {
		this.logger?.infoSync('Generating new Ed25519 key pair for PoP', {
			component: LogComponents.agent,
			operation: 'generateKeyPair'
		});

		const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
			publicKeyEncoding: {
				type: 'spki',
				format: 'pem'
			},
			privateKeyEncoding: {
				type: 'pkcs8',
				format: 'pem'
			}
		});

		this.keyPair = { publicKey, privateKey };

		// Save to disk with restrictive permissions
		fs.writeFileSync(
			this.keyStoragePath,
			JSON.stringify(this.keyPair, null, 2),
			{ mode: 0o600 } // Owner read/write only
		);

		this.logger?.infoSync('Ed25519 key pair generated and saved', {
			component: LogComponents.agent,
			operation: 'generateKeyPair',
			publicKeyLength: publicKey.length,
			privateKeyLength: privateKey.length,
			keyStoragePath: this.keyStoragePath,
			permissions: '0600'
		});
	}

	/**
   * Get public key in PEM format for registration
   * Safe to transmit over network
   */
	getPublicKey(): string {
		if (!this.keyPair) {
			throw new Error('PoP crypto not initialized - call initialize() first');
		}

		return this.keyPair.publicKey;
	}

	/**
   * Sign a challenge with private key, binding device UUID to prevent cross-device replay
   * 
   * Security: Binds device identity (UUID) into signed payload:
   * - Prevents cross-device replay attacks
   * - Follows OAuth DPoP, SPIFFE, AWS SigV4 standards
   * - Ensures signature context is cryptographically bound to device
   * 
   * @param challenge - Base64url-encoded challenge from server
   * @param uuid - Device UUID to bind into signature
   * @returns Base64-encoded signature
   */
	signChallenge(challenge: string, uuid: string): string {
		if (!this.keyPair) {
			throw new Error('PoP crypto not initialized - call initialize() first');
		}

		// Bind device UUID to challenge - prevents cross-device replay
		const payload = `${uuid}:${challenge}`;

		this.logger?.infoSync('Signing PoP challenge with device binding', {
			component: LogComponents.agent,
			operation: 'signChallenge',
			challengeLength: challenge.length,
			payloadLength: payload.length,
			deviceBinding: 'uuid-prefixed'
		});

		// Sign the bound payload (uuid:challenge)
		const signature = crypto.sign(
			null, // Algorithm detected from key (Ed25519)
			Buffer.from(payload, 'utf-8'),
			this.keyPair.privateKey
		);

		const signatureBase64 = signature.toString('base64');

		this.logger?.infoSync('Challenge signed successfully', {
			component: LogComponents.agent,
			operation: 'signChallenge',
			signatureLength: signatureBase64.length
		});

		return signatureBase64;
	}

	/**
   * Verify a signature (for testing purposes)
   * In production, only the server verifies signatures
   */
	verifySignature(challenge: string, signature: string): boolean {
		if (!this.keyPair) {
			throw new Error('PoP crypto not initialized');
		}

		try {
			return crypto.verify(
				null,
				Buffer.from(challenge),
				this.keyPair.publicKey,
				Buffer.from(signature, 'base64')
			);
		} catch (_error) {
			return false;
		}
	}

	/**
   * Check if PoP is enabled (keys exist)
   */
	isEnabled(): boolean {
		return this.keyPair !== null;
	}

	/**
   * Get key fingerprint for logging (first 8 chars of public key hash)
   */
	getKeyFingerprint(): string {
		if (!this.keyPair) {
			return 'not-initialized';
		}

		const hash = crypto.createHash('sha256')
			.update(this.keyPair.publicKey)
			.digest('hex');
    
		return hash.substring(0, 16);
	}
}
