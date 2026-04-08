import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const SCRYPT_PREFIX = 'scrypt';
const HMAC_PREFIX = 'hmac-sha256';
const LEGACY_BCRYPT_PATTERN = /^\$2[aby]\$/;
const SCRYPT_N = parseInt(process.env.SCRYPT_N || '16384', 10);
const SCRYPT_R = parseInt(process.env.SCRYPT_R || '8', 10);
const SCRYPT_P = parseInt(process.env.SCRYPT_P || '1', 10);
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 32 * 1024 * 1024;

export type MachineSecretPurpose = 'device-api-key' | 'provisioning-key' | 'refresh-token';

export interface VerifyHashResult {
  valid: boolean;
  upgradedHash?: string;
}

function getPasswordPepper(): string {
  return process.env.PASSWORD_HASH_PEPPER || '';
}

function getDigestPepper(): string {
  return process.env.SECRET_DIGEST_PEPPER || process.env.JWT_SECRET || 'iotistic-dev-secret-digest-pepper';
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isLegacyBcryptHash(value: string): boolean {
  return LEGACY_BCRYPT_PATTERN.test(value);
}

function scryptAsync(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      `${secret}${getPasswordPepper()}`,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey as Buffer);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scryptAsync(password, salt);
  return [
    SCRYPT_PREFIX,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, storedHash: string): Promise<VerifyHashResult> {
  if (!storedHash) {
    return { valid: false };
  }

  if (storedHash.startsWith(`${SCRYPT_PREFIX}$`)) {
    const parts = storedHash.split('$');
    if (parts.length !== 6) {
      return { valid: false };
    }

    const [, n, r, p, saltBase64, hashBase64] = parts;
    const salt = Buffer.from(saltBase64, 'base64url');
    const expectedKey = Buffer.from(hashBase64, 'base64url');
    const derivedKey = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(
        `${password}${getPasswordPepper()}`,
        salt,
        expectedKey.length,
        {
          N: parseInt(n, 10),
          r: parseInt(r, 10),
          p: parseInt(p, 10),
          maxmem: SCRYPT_MAXMEM,
        },
        (error, value) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(value as Buffer);
        },
      );
    });

    return {
      valid: expectedKey.length === derivedKey.length && crypto.timingSafeEqual(expectedKey, derivedKey),
    };
  }

  if (isLegacyBcryptHash(storedHash)) {
    const valid = await bcrypt.compare(password, storedHash);
    return {
      valid,
      upgradedHash: valid ? await hashPassword(password) : undefined,
    };
  }

  return { valid: false };
}

export function hashMachineSecretDigest(secret: string, purpose: MachineSecretPurpose): string {
  return crypto
    .createHmac('sha256', getDigestPepper())
    .update(`${purpose}:${secret}`)
    .digest('hex');
}

export function hashLegacySha256(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function hashMachineSecret(secret: string, purpose: MachineSecretPurpose): string {
  return `${HMAC_PREFIX}$${purpose}$${hashMachineSecretDigest(secret, purpose)}`;
}

export async function verifyMachineSecret(
  secret: string,
  storedHash: string,
  purpose: MachineSecretPurpose,
): Promise<VerifyHashResult> {
  if (!storedHash) {
    return { valid: false };
  }

  if (storedHash.startsWith(`${HMAC_PREFIX}$`)) {
    const parts = storedHash.split('$');
    if (parts.length !== 3) {
      return { valid: false };
    }

    const [, storedPurpose, digest] = parts;
    if (storedPurpose !== purpose) {
      return { valid: false };
    }

    const expectedDigest = hashMachineSecretDigest(secret, purpose);
    return { valid: timingSafeHexEqual(expectedDigest, digest) };
  }

  if (isLegacyBcryptHash(storedHash)) {
    const valid = await bcrypt.compare(secret, storedHash);
    return {
      valid,
      upgradedHash: valid ? hashMachineSecret(secret, purpose) : undefined,
    };
  }

  return { valid: false };
}