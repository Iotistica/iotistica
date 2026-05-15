/**
 * Encryption Utilities for Sensitive Data Storage
 * =================================================
 * 
 * AES-256-GCM encryption for credentials stored in SQLite database.
 * 
 * Security Model:
 * - Device-local master key (256-bit) stored in separate file
 * - AES-256-GCM authenticated encryption (NIST recommended)
 * - Unique IV per encryption operation (prevents pattern analysis)
 * - Auth tag prevents tampering
 * 
 * Future Enhancements:
 * - OS keyring integration (Windows DPAPI, macOS Keychain, Linux Secret Service)
 * - TPM/Secure Enclave for hardware-backed encryption
 * - Key rotation support
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits (recommended for GCM)

/**
 * Master key manager for device-local encryption
 */
export class MasterKeyManager {
	private static masterKey: Buffer | null = null;
	private static keyPath: string;
	private static logger?: AgentLogger;

	private static debug(message: string, context?: Record<string, unknown>): void {
		this.logger?.debugSync(message, {
			component: LogComponents.security,
			operation: 'master-key',
			...context,
		});
	}

	/**
	* Initialize master key path (defaults to .iotistic directory)
	*/
	static initialize(dataDir?: string, logger?: AgentLogger): void {
		const baseDir = dataDir || path.join(process.env.HOME || process.env.USERPROFILE || '/root', '.iotistic');
		this.keyPath = path.join(baseDir, '.master.key');
		this.logger = logger;
		this.debug('Master key manager initialized', { dataDir, keyPath: this.keyPath });
	}

	/**
	* Get or generate master encryption key
	* Key is stored in file system with restricted permissions
	*/
	static getMasterKey(): Buffer {
		if (this.masterKey) {
			return this.masterKey;
		}

		if (!this.keyPath) {
			this.initialize();
		}

		// Check if key file exists
		const keyExists = fs.existsSync(this.keyPath);
	
		if (keyExists) {
			// Load existing key
			this.masterKey = fs.readFileSync(this.keyPath);
			
			if (this.masterKey.length !== KEY_LENGTH) {
				throw new Error(`Invalid master key length: ${this.masterKey.length} (expected ${KEY_LENGTH})`);
			}
		} else {
			// Generate new master key
			this.masterKey = crypto.randomBytes(KEY_LENGTH);
			this.debug('Generated new master key', { keyPath: this.keyPath });
			
			// Ensure directory exists
			const dir = path.dirname(this.keyPath);
			if (!fs.existsSync(dir)) {
				this.debug('Creating master key directory', { dir });
				fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			}
			
			// Write key with restricted permissions (owner read/write only)
			fs.writeFileSync(this.keyPath, this.masterKey, { mode: 0o600 });
			this.debug('Master key saved successfully', { keyPath: this.keyPath });
		}

		return this.masterKey;
	}

	/**
	* Rotate master key (advanced - requires re-encrypting all data)
	*/
	static async rotateMasterKey(): Promise<Buffer> {
		const oldKey = this.getMasterKey();
		const newKey = crypto.randomBytes(KEY_LENGTH);
		
		// Backup old key
		const backupPath = `${this.keyPath}.backup.${Date.now()}`;
		fs.copyFileSync(this.keyPath, backupPath);
		
		// Write new key
		fs.writeFileSync(this.keyPath, newKey, { mode: 0o600 });
		this.masterKey = newKey;
		
		return oldKey; // Return old key so caller can re-encrypt data
	}
}

/**
 * Encrypt sensitive string data using AES-256-GCM
 * 
 * @param plaintext - Data to encrypt
 * @returns Base64-encoded encrypted data (format: iv:authTag:ciphertext)
 */
export function encryptData(plaintext: string): string {
	if (!plaintext) {
		return plaintext; // Don't encrypt empty strings
	}

	const masterKey = MasterKeyManager.getMasterKey();
	const iv = crypto.randomBytes(IV_LENGTH);
	
	const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
	
	let encrypted = cipher.update(plaintext, 'utf8', 'base64');
	encrypted += cipher.final('base64');
	
	const authTag = cipher.getAuthTag();
	
	// Format: iv:authTag:ciphertext (all base64)
	return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt AES-256-GCM encrypted data
 * 
 * @param encrypted - Base64-encoded encrypted data (format: iv:authTag:ciphertext)
 * @returns Decrypted plaintext
 */
export function decryptData(encrypted: string): string {
	if (!encrypted?.includes(':')) {
		return encrypted; // Not encrypted or empty
	}

	try {
		const masterKey = MasterKeyManager.getMasterKey();
		const parts = encrypted.split(':');
		
		if (parts.length !== 3) {
			throw new Error('Invalid encrypted data format');
		}

		const iv = Buffer.from(parts[0], 'base64');
		const authTag = Buffer.from(parts[1], 'base64');
		const ciphertext = parts[2];
		
		const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
		decipher.setAuthTag(authTag);
		
		let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
		decrypted += decipher.final('utf8');
		
		return decrypted;
	} catch (error) {
		// If decryption fails, data may be corrupted or key changed
		throw new Error(`Decryption failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Check if string is encrypted (has iv:authTag:ciphertext format)
 */
export function isEncrypted(data: string | null | undefined): boolean {
	if (!data) return false;
	const parts = data.split(':');
	return parts.length === 3 && parts.every(p => p.length > 0);
}

/**
 * Migrate plaintext data to encrypted (idempotent)
 * Useful for upgrading existing databases
 */
export function migrateToEncrypted(plaintext: string | null): string | null {
	if (!plaintext) return plaintext;
	if (isEncrypted(plaintext)) return plaintext; // Already encrypted
	return encryptData(plaintext);
}

/**
 * Fields that should be encrypted in Device model
 */
export const ENCRYPTED_DEVICE_FIELDS = [
	'deviceApiKey',
	'provisioningApiKey',
	'apiKey',
	'mqttUsername',
	'mqttPassword',
	'mqttBrokerConfig', // Contains MQTT credentials in JSON
] as const;

/**
 * Encrypt sensitive fields in device record
 */
export function encryptDeviceRecord(record: any): any {
	const encrypted = { ...record };
	
	for (const field of ENCRYPTED_DEVICE_FIELDS) {
		if (encrypted[field] && typeof encrypted[field] === 'string') {
			encrypted[field] = encryptData(encrypted[field]);
		}
	}
	
	return encrypted;
}

/**
 * Decrypt sensitive fields in device record
 */
export function decryptDeviceRecord(record: any): any {
	const decrypted = { ...record };
	
	for (const field of ENCRYPTED_DEVICE_FIELDS) {
		if (decrypted[field] && typeof decrypted[field] === 'string') {
			try {
				decrypted[field] = decryptData(decrypted[field]);
			} catch (error) {
				// Log error but don't crash - may be legacy plaintext data
				console.warn(`Failed to decrypt ${field}:`, error instanceof Error ? error.message : String(error));
			}
		}
	}
	
	return decrypted;
}
