/**
 * MQTT Message ID Generator
 * 
 * Generates unique message identifiers for MQTT publish operations.
 * Used for application-level deduplication in HA bridge configurations.
 * 
 * Format: {deviceUuid}-{timestamp}-{sequence}-{random}
 * Example: abc123-1705334400000-42-x7k9p
 * 
 * Components:
 * - deviceUuid: Ensures uniqueness across devices
 * - timestamp: Milliseconds since epoch (for time-based ordering)
 * - sequence: Counter to handle multiple messages in same millisecond
 * - random: 5-char alphanumeric suffix for extra entropy
 */

import { randomBytes } from 'crypto';

/**
 * Message ID generator (singleton per device)
 */
export class MessageIdGenerator {
	private deviceUuid: string;
	private sequence: number = 0;
	private lastTimestamp: number = 0;

	constructor(deviceUuid: string) {
		this.deviceUuid = deviceUuid;
	}

	/**
   * Generate unique message ID
   * 
   * @returns Message ID string (e.g., "abc123-1705334400000-42-x7k9p")
   */
	public generate(): string {
		const now = Date.now();
    
		// Reset sequence if timestamp changed
		if (now !== this.lastTimestamp) {
			this.sequence = 0;
			this.lastTimestamp = now;
		} else {
			this.sequence++;
		}

		// Generate random suffix (5 chars, alphanumeric)
		const randomSuffix = randomBytes(3)
			.toString('base64')
			.replace(/[^a-zA-Z0-9]/g, '')
			.substring(0, 5)
			.toLowerCase();

		return `${this.deviceUuid}-${now}-${this.sequence}-${randomSuffix}`;
	}

	/**
   * Reset sequence counter (for testing)
   */
	public reset(): void {
		this.sequence = 0;
		this.lastTimestamp = 0;
	}
}

/**
 * Global message ID generator instance
 * Initialized with device UUID on first use
 */
let globalGenerator: MessageIdGenerator | null = null;

/**
 * Initialize global message ID generator
 * 
 * @param deviceUuid - Device UUID
 */
export function initMessageIdGenerator(deviceUuid: string): void {
	if (globalGenerator && globalGenerator['deviceUuid'] !== deviceUuid) {
		throw new Error(`Message ID generator already initialized with different device UUID`);
	}
	globalGenerator = new MessageIdGenerator(deviceUuid);
}

/**
 * Generate message ID using global generator
 * 
 * @returns Message ID string
 * @throws Error if generator not initialized
 */
export function generateMessageId(): string {
	if (!globalGenerator) {
		throw new Error('Message ID generator not initialized. Call initMessageIdGenerator() first.');
	}
	return globalGenerator.generate();
}

/**
 * Get global message ID generator instance
 * 
 * @returns Generator instance or null if not initialized
 */
export function getMessageIdGenerator(): MessageIdGenerator | null {
	return globalGenerator;
}
