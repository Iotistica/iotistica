/**
 * Proof-of-Possession Verification
 * 
 * Challenge-response mechanism for secure key exchange without transmitting secrets.
 * Device proves key possession using HMAC-SHA256 over a server-generated challenge.
 */

import * as crypto from 'crypto';
import logger from '../../utils/logger';

/**
 * Generate a random challenge for proof-of-possession
 * 64 hex characters = 32 bytes
 */
export function generateChallenge(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Parse versioned API key to extract kid and secret
 * 
 * Formats:
 * - v1: 64 hex chars (legacy format, no kid)
 * - v2: v2_kid_secret (8 hex kid + 64 hex secret)
 */
export interface ParsedApiKey {
  version: 'v1' | 'v2';
  kid?: string; // Key ID (v2 only)
  secret: string; // The actual secret
}

export function parseApiKey(key: string): ParsedApiKey {
  // Check for v2 format: v2_kid_secret
  if (key.startsWith('v2_')) {
    const parts = key.split('_');
    if (parts.length !== 3) {
      throw new Error('Invalid v2 API key format. Expected: v2_kid_secret');
    }
    
    const [version, kid, secret] = parts;
    
    // Validate kid is 8 hex chars
    if (!kid.match(/^[a-f0-9]{8}$/i)) {
      throw new Error('Invalid v2 API key: kid must be 8 hex characters');
    }
    
    // Validate secret is 64 hex chars (32 bytes)
    if (!secret.match(/^[a-f0-9]{64}$/i)) {
      throw new Error('Invalid v2 API key: secret must be 64 hex characters');
    }
    
    return {
      version: 'v2',
      kid,
      secret
    };
  }
  
  // Check for v1 format: 64 hex chars (legacy)
  if (key.match(/^[a-f0-9]{64}$/i)) {
    return {
      version: 'v1',
      secret: key
    };
  }
  
  throw new Error('Invalid API key format. Expected v1 (64 hex chars) or v2 (v2_kid_secret)');
}

/**
 * Verify proof-of-possession
 * 
 * Device computes: HMAC-SHA256(secret, challenge:uuid)
 * Server verifies by computing the same and comparing with constant-time comparison
 */
export function verifyProofOfPossession(
  challenge: string,
  uuid: string,
  proof: string,
  apiKeySecret: string
): boolean {
  try {
    // Recompute HMAC from challenge, uuid, and secret
    const expectedProof = crypto
      .createHmac('sha256', apiKeySecret)
      .update(`${challenge}:${uuid}`)
      .digest('hex');
    
    // Use constant-time comparison to prevent timing attacks
    const proofBuffer = Buffer.from(proof);
    const expectedBuffer = Buffer.from(expectedProof);
    
    // Buffers must be same length for timingSafeEqual
    if (proofBuffer.length !== expectedBuffer.length) {
      return false;
    }
    
    return crypto.timingSafeEqual(proofBuffer, expectedBuffer);
  } catch (error: any) {
    logger.error('Error verifying proof-of-possession:', error);
    return false;
  }
}

/**
 * Compute proof-of-possession (for testing/debugging)
 * Device side would use this to create the proof
 */
export function computeProofOfPossession(
  challenge: string,
  uuid: string,
  apiKeySecret: string
): string {
  return crypto
    .createHmac('sha256', apiKeySecret)
    .update(`${challenge}:${uuid}`)
    .digest('hex');
}
