# Device API Key Security Architecture

## Overview

The device API key is the primary authentication credential for edge devices to communicate with the cloud API. This document describes the security architecture, versioning strategy, and best practices.

## Security Requirements

### Cryptographic Strength
- **Algorithm**: `crypto.randomBytes(32)` - CSPRNG (Cryptographically Secure Pseudo-Random Number Generator)
- **Entropy**: 256 bits (32 bytes) - equivalent to AES-256 security level
- **Uniqueness**: Each device generates a unique key - no key reuse across devices
- **Storage**: Keys are hashed with bcrypt (cost factor 10) before storage in cloud database

### Key Format Evolution

#### Version 1 (Legacy - Deprecated)
```
Format: <64_hex_chars>
Example: a1b2c3d4e5f6...0123456789abcdef (64 chars)
Security: 256-bit entropy ✓
Rotation: Limited (no key ID) ⚠️
```

**Limitations:**
- No version identifier - cannot evolve format
- No key ID - difficult to track during rotation
- No metadata - hard to audit key lifecycle

#### Version 2 (Current - Recommended)
```
Format: v2_<kid>_<secret>
Example: v2_a1b2c3d4_f9e8d7c6b5a4...3210fedcba98 (75 chars total)
Components:
  - version: "v2" (format identifier)
  - kid: 8 hex chars (key ID for rotation tracking)
  - secret: 64 hex chars (256-bit cryptographic secret)
Security: 256-bit entropy ✓
Rotation: Full support (kid enables multi-key strategies) ✓
Metadata: Version + kid enable audit trails ✓
```

**Advantages:**
- **Version prefix** enables future format changes without breaking existing keys
- **Key ID (kid)** enables:
  - Key rotation tracking and audit trails
  - Multi-key strategies (e.g., overlap period during rotation)
  - Faster key lookup in databases (index on kid)
- **Backward compatible** - v1 keys continue to work
- **Parseable** - can extract metadata without decoding

## API Key Lifecycle

### 1. Generation (Device Bootstrap)
```typescript
// New device initialization
const deviceInfo = {
  uuid: crypto.randomUUID(),
  deviceApiKey: generateAPIKey('v2'), // v2_<kid>_<secret>
  provisioned: false,
};
```

**Security Properties:**
- Key generated **before** trust establishment (zero-trust model)
- Key never transmitted in cleartext (always over TLS)
- Key scoped to single device (cannot be reused)

### 2. Provisioning (Two-Phase Authentication)

**Phase 1: Device Registration**
```
Device → Cloud API
POST /api/device/register
Authorization: Bearer <provisioningApiKey> (fleet-level, temporary)
Body: {
  uuid: "device-uuid",
  deviceApiKey: "v2_a1b2c3d4_secret...", // Device's permanent key
  ...metadata
}

Cloud → Device
Response: {
  id: 123,
  challenge: "8f3a2e1d...", // 64-char nonce for key exchange proof
  mqtt: { brokerConfig, credentials },
  vpn: { tailscale: {...} }
}
```

**Phase 2: Key Exchange (Proof-of-Possession)**
```
Device computes HMAC proof:
  proof = HMAC-SHA256(deviceApiKey.secret, challenge + ":" + uuid)

Device → Cloud API
POST /api/device/:uuid/key-exchange
Authorization: Bearer <provisioningApiKey> (NOT deviceApiKey - prevents circular auth)
Body: { 
  uuid,
  challenge: "8f3a2e1d...", // Server's nonce
  proof: "f9e8d7c6..." // HMAC signature
}

Cloud verifies:
  1. Challenge was issued within last 60 seconds (prevents replay)
  2. Challenge matches device's UUID
  3. HMAC(storedDeviceApiKey.secret, challenge:uuid) == proof
  4. Timing-safe comparison (prevents timing attacks)

Cloud → Device
Response: { status: "ok" }
```

**Security Properties:**
- **No key transmission**: deviceApiKey never sent in Phase 2 (only HMAC proof)
- **Proof-of-possession**: Device proves it knows the key without revealing it
- **Replay protection**: Challenge is single-use, expires after 60 seconds
- **Binding**: Proof binds to both challenge and device UUID
- **No circular auth**: Authentication uses provisioningApiKey, not deviceApiKey
- **Timing safety**: Constant-time HMAC comparison prevents timing attacks

**Legacy v1 Fallback** (deprecated):
If server doesn't provide challenge, device falls back to insecure v1 method:
- Transmits deviceApiKey in request body
- Authenticates with same key (circular auth vulnerability)
- Vulnerable to replay attacks if key is intercepted
- Logs warning about security risk

**Phase 3: Provisioning Key Removal**
```typescript
// Remove one-time provisioning key
this.deviceInfo.provisioningApiKey = undefined;
this.deviceInfo.provisioned = true;
await this.saveDeviceInfo();
```

### 3. Authentication (Ongoing)

**Standard API Calls:**
```
Device → Cloud API
GET /api/cloud/target-state
Authorization: Bearer v2_a1b2c3d4_secret...
```

**Cloud API Validation:**
1. Extract `deviceApiKey` from `Authorization: Bearer <token>` header
2. Parse key to extract version and kid: `parseAPIKey(token)`
3. Hash provided key with bcrypt
4. Compare with stored hash in database
5. Return 401 Unauthorized if mismatch

### 4. Key Rotation

**Rotation Triggers:**
- **Scheduled**: Every 90 days (SOC-2 compliance)
- **Cloud-initiated**: Security event or policy change
- **Manual**: Operator-initiated via API
- **Recovery**: After suspected compromise

**Hot-Swap Rotation Process:**
```typescript
// Cloud generates new key and notifies device
const newKey = generateAPIKey('v2'); // New kid
const rotation = await rotateDeviceApiKey(uuid, {
  reason: 'cloud_rotate',
  overlapPeriodMinutes: 5, // Both keys valid for 5 minutes
});

// Device receives rotation event via MQTT
// agent/{uuid}/key-rotation
{
  newKey: "v2_b2c3d4e5_newsecret...",
  expiresAt: "2026-01-06T12:05:00Z", // Old key expires
  version: 2
}

// CredentialManager validates and swaps key
credentialManager.rotateKey(newKey, 'cloud_rotate');
```

**Overlap Period:**
- Both old and new keys valid for configurable period (default: 5 minutes)
- Prevents service disruption during rotation
- Old key automatically invalidated after expiry

## Security Best Practices

### Key Generation
```typescript
// ✓ CORRECT - Use v2 versioned keys
const apiKey = generateAPIKey('v2');

// ✗ AVOID - Legacy v1 format (deprecated)
const legacyKey = generateAPIKey('v1');
```

### Key Logging
```typescript
// ✓ CORRECT - Log fingerprint only
logger.infoSync('Device authenticated', {
  keyFingerprint: getAPIKeyFingerprint(apiKey), // "v2:a1b2c3d4"
  keyVersion: metadata.version,
  keyId: metadata.kid,
});

// ✗ NEVER - Log full key
logger.infoSync('Device authenticated', {
  apiKey: apiKey, // ❌ SECURITY VIOLATION
});
```

### Key Validation
```typescript
// ✓ CORRECT - Validate format before use
const metadata = parseAPIKey(apiKey);
if (!metadata) {
  throw new Error('Invalid API key format');
}
if (metadata.version === 'v1') {
  logger.warnSync('Device using deprecated v1 key format');
}

// ✓ CORRECT - Use validateAPIKeyFormat for quick check
if (!validateAPIKeyFormat(apiKey)) {
  throw new Error('Invalid API key');
}
```

### Key Storage
```typescript
// ✓ CORRECT - Store in encrypted database
await saveDeviceInfo({
  deviceApiKey: apiKey, // Plain in local SQLite (disk encrypted)
});

// Cloud API stores bcrypt hash only
const hashedKey = await bcrypt.hash(apiKey, 10);
await db('devices').insert({ 
  uuid, 
  device_api_key_hash: hashedKey // Never store plaintext
});
```

## Threat Model & Mitigations

| Threat | Risk | Mitigation |
|--------|------|------------|
| Key interception (MITM) | High | TLS 1.3 mandatory, certificate pinning optional |
| Key theft from device | Medium | OS disk encryption, secure boot recommended |
| Key reuse across devices | High | UUID-scoped keys, crypto.randomBytes uniqueness |
| Brute force attack | High | 256-bit entropy (2^256 space), bcrypt hashing |
| Key logged in plaintext | Medium | Fingerprint logging only, audit all logs |
| Compromised rotation | Medium | Overlap period + validation before commit |
| Rollback attack | Low | Monotonic version numbers, signed rotation events |
| **Replay attack (key exchange)** | **Critical** | **Challenge-response HMAC proof-of-possession** |
| **Circular authentication** | **High** | **Proof uses provisioningApiKey, not deviceApiKey** |
| Timing attacks on HMAC | Medium | Constant-time comparison (crypto.timingSafeEqual) |

## Migration Path

### Upgrading from v1 to v2 Keys

**Automatic Migration** (recommended):
```typescript
// Next rotation auto-upgrades to v2
const rotation = await rotateDeviceApiKey(uuid, {
  reason: 'cloud_rotate',
  forceVersion: 'v2', // Auto-upgrade legacy devices
});
```

**Manual Migration**:
```typescript
// Check current key version
const metadata = parseAPIKey(deviceInfo.deviceApiKey);
if (metadata.version === 'v1') {
  // Trigger rotation to v2
  await deviceManager.rotateAPIKey({ forceVersion: 'v2' });
}
```

**Backward Compatibility:**
- v1 keys continue to work indefinitely
- parseAPIKey() supports both formats
- Cloud API validates both formats
- No breaking changes for existing deployments

## Compliance & Audit

### SOC-2 Requirements
- ✓ Key rotation every 90 days
- ✓ Audit trail for all key events (kid enables tracking)
- ✓ Cryptographically secure generation
- ✓ Encrypted storage (bcrypt hashing)
- ✓ Access logging and monitoring

### Key Event Logging
```typescript
// CredentialManager emits audit events
credentialManager.on('apiKeyRotated', (event) => {
  logger.infoSync('API key rotated', {
    rotatedAt: event.rotatedAt,
    reason: event.reason,
    keyFingerprint: event.keyFingerprint,
    version: event.version,
    rotationId: event.rotationId,
  });
});
```

## Testing & Validation

### Unit Tests
```bash
# Test key generation and parsing
cd agent && npm run test:unit -- crypto.test.ts

# Test device manager provisioning
npm run test:unit -- device-manager.test.ts
```

### Integration Tests
```bash
# Test full provisioning flow
npm run test:integration -- provisioning.test.ts

# Test key rotation
npm run test:integration -- credential-manager.test.ts
```

### Security Audit Checklist
- [ ] Verify generateAPIKey uses crypto.randomBytes (not Math.random)
- [ ] Confirm keys are never logged in full (only fingerprints)
- [ ] Check TLS is enforced for all API calls
- [ ] Validate bcrypt cost factor ≥ 10 in cloud API
- [ ] Test key rotation with overlap period
- [ ] Verify old keys expire after rotation
- [ ] Audit all key storage locations (SQLite, logs, memory dumps)

## References

- **NIST SP 800-57**: Key Management Recommendations
- **OWASP API Security**: Authentication best practices
- **Balena Supervisor**: Two-phase authentication model
- **JWT RFC 7517**: JSON Web Key (JWK) kid field inspiration

## Future Enhancements

### Planned Features
- **v3 format**: Ed25519 signing for key attestation
- **Multi-key support**: Device can hold multiple valid keys during rotation
- **Hardware security**: TPM/Secure Enclave integration
- **Key derivation**: HKDF-based subkeys for MQTT, VPN, etc.
- **Zero-knowledge proofs**: Authenticate without revealing key

### Migration Timeline
- **Q1 2026**: v2 format launched ✓
- **Q2 2026**: Auto-upgrade all v1 keys to v2
- **Q3 2026**: v1 deprecation warning (still supported)
- **Q1 2027**: v1 format end-of-life (blocked for new devices)

---

**Last Updated**: January 6, 2026  
**Maintainer**: IoT Platform Security Team  
**Review Cycle**: Quarterly
