import { createHmac, timingSafeEqual } from 'crypto';

type JwtAudience = string | string[];

type JwtRegisteredClaims = {
  aud?: JwtAudience;
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
};

type SignOptions = {
  audience?: JwtAudience;
  expiresIn?: number | string;
  issuer?: string;
  notBefore?: number | string;
};

type VerifyOptions = {
  audience?: JwtAudience;
  issuer?: string;
  requireExpiration?: boolean;
};

function encodeBase64Url(value: Buffer | string): string {
  return Buffer.isBuffer(value)
    ? value.toString('base64url')
    : Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64UrlJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function parseDurationSeconds(value: number | string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const match = /^(\d+)([smhdw])$/.exec(String(value));
  if (!match) {
    throw new Error(`Unsupported JWT duration: ${value}`);
  }

  const amount = Number.parseInt(match[1] || '0', 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
  };

  return amount * (multipliers[unit] || 0);
}

function signInput(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`;
}

function computeSignature(input: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(input).digest();
}

function audiencesMatch(expected: JwtAudience, actual: unknown): boolean {
  const expectedValues = Array.isArray(expected) ? expected : [expected];
  const actualValues = Array.isArray(actual)
    ? actual.filter((value): value is string => typeof value === 'string')
    : typeof actual === 'string'
      ? [actual]
      : [];

  return expectedValues.some((value) => actualValues.includes(value));
}

export function decodeJwtHeader(token: string): Record<string, unknown> {
  const [header] = token.split('.');
  if (!header) {
    throw new Error('Invalid JWT format');
  }
  return decodeBase64UrlJson<Record<string, unknown>>(header);
}

export function signHs256Token<T extends Record<string, unknown>>(
  payload: T,
  secret: string,
  options: SignOptions = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: T & JwtRegisteredClaims = {
    ...payload,
    iat: now,
  };

  if (options.issuer) {
    claims.iss = options.issuer;
  }

  if (options.audience) {
    claims.aud = options.audience;
  }

  if (options.notBefore !== undefined) {
    claims.nbf = now + parseDurationSeconds(options.notBefore);
  }

  if (options.expiresIn !== undefined) {
    claims.exp = now + parseDurationSeconds(options.expiresIn);
  }

  const header = { alg: 'HS256', typ: 'JWT' };
  const input = signInput(header, claims);
  const signature = encodeBase64Url(computeSignature(input, secret));
  return `${input}.${signature}`;
}

export function verifyHs256Token<T extends Record<string, unknown>>(
  token: string,
  secret: string,
  options: VerifyOptions = {},
): T & JwtRegisteredClaims {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('Invalid JWT format');
  }

  const header = decodeBase64UrlJson<Record<string, unknown>>(encodedHeader);
  if (header.alg !== 'HS256') {
    throw new Error(`Unsupported JWT algorithm: ${String(header.alg || 'unknown')}`);
  }

  const expectedSignature = computeSignature(`${encodedHeader}.${encodedPayload}`, secret);
  const actualSignature = Buffer.from(encodedSignature, 'base64url');
  if (
    expectedSignature.length !== actualSignature.length
    || !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    throw new Error('Invalid token signature');
  }

  const payload = decodeBase64UrlJson<T & JwtRegisteredClaims>(encodedPayload);
  const now = Math.floor(Date.now() / 1000);

  if (options.requireExpiration !== false && typeof payload.exp !== 'number') {
    throw new Error('Token missing exp claim');
  }

  if (typeof payload.nbf === 'number' && now < payload.nbf) {
    throw new Error('Token is not active yet');
  }

  if (typeof payload.exp === 'number' && now >= payload.exp) {
    throw new Error('Token has expired');
  }

  if (options.issuer && payload.iss !== options.issuer) {
    throw new Error('Invalid token issuer');
  }

  if (options.audience && !audiencesMatch(options.audience, payload.aud)) {
    throw new Error('Invalid token audience');
  }

  return payload;
}