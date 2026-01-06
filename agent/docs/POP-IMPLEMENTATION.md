# Proof of Possession (PoP) Implementation

## Overview

The agent now supports **asymmetric cryptographic authentication** using Ed25519 key pairs for Proof of Possession (PoP). This eliminates the need to transmit device API keys and provides stronger security guarantees.

## Architecture

### Components

1. **PopCryptoManager** (`agent/src/security/pop-crypto.ts`)
   - Generates and manages Ed25519 key pairs
   - Signs challenges with private key
   - Stores keys securely in `/app/data/.pop-keys.json`

2. **DeviceManager** (`agent/src/device-manager/provisioning.ts`)
   - Integrates PoP into provisioning flow
   - Sends public key during registration
   - Signs challenges during key exchange

3. **API Server** (`api/src/routes/provisioning.ts`, `api/src/services/provisioning.service.ts`)
   - Issues challenges during registration
   - Verifies Ed25519 signatures during key exchange
   - Falls back to bcrypt for backward compatibility

## Flow

### Phase 1: Registration with Public Key

```
Agent                                    API
  |                                       |
  |-- Generate Ed25519 key pair -------->|
  |   (first boot only)                  |
  |                                       |
  |-- POST /device/register ------------->|
  |   {                                   |
  |     uuid,                             |
  |     deviceApiKey,                     |
  |     devicePublicKey (PEM)  <------    |
  |   }                                   |
  |                                       |
  |<-- 200 OK ----------------------------|
  |   {                                   |
  |     id, uuid, mqtt,                   |
  |     challenge: "base64url nonce" <----|
  |   }                                   |
```

### Phase 2: Key Exchange with Signature

```
Agent                                    API
  |                                       |
  |-- Sign challenge with private key -->|
  |   signature = Ed25519.sign(          |
  |     privateKey,                       |
  |     challenge                         |
  |   )                                   |
  |                                       |
  |-- POST /device/:uuid/key-exchange --->|
  |   Authorization: Bearer deviceApiKey |
  |   {                                   |
  |     deviceApiKey,                     |
  |     signature (base64)  <----------   |
  |   }                                   |
  |                                       |
  |                          Verify       |
  |                          signature -->|
  |                                       |
  |<-- 200 OK ----------------------------|
  |   { status: "ok" }                    |
  |                                       |
  |-- Device marked as pop_verified ----->|
```

## Security Features

### Why Ed25519?

- **Fast**: ~60μs signature generation
- **Small**: 32-byte keys, 64-byte signatures
- **Secure**: 128-bit security level (equivalent to 3072-bit RSA)
- **Native**: Built into Node.js crypto module

### Key Security Properties

1. **Private key never leaves device** - Only public key transmitted
2. **Challenge-response** - Server issues unique nonce per registration
3. **Replay protection** - Challenges expire after 5 minutes
4. **Immutable public key** - Cannot be changed after first registration (requires reprovisioning)
5. **Signature verification** - Cryptographic proof of key possession

### Backward Compatibility

The system supports **dual authentication modes**:

- **PoP (preferred)**: If device sends `devicePublicKey` during registration
- **Bcrypt fallback (legacy)**: If no public key provided

API logs clearly indicate which mode is used:
```
⚠️ Using LEGACY bcrypt verification (not PoP)
  - Reason: device has no public key (not PoP-enabled)
  - Recommendation: Update agent to send devicePublicKey
```

## Implementation Details

### Agent Code Changes

**New Files:**
- `agent/src/security/pop-crypto.ts` - Ed25519 key management

**Modified Files:**
- `agent/src/device-manager/provisioning.ts` - PoP integration
- `agent/src/device-manager/types.ts` - Add `devicePublicKey` and `signature` fields

**Key Changes:**
```typescript
// Initialize PoP crypto on first boot
this.popCrypto = new PopCryptoManager('/app/data', this.logger);
await this.popCrypto.initialize();

// Send public key during registration
const devicePublicKey = this.popCrypto?.getPublicKey();
await this.registerWithAPI({
  uuid,
  deviceName,
  deviceType,
  deviceApiKey,
  devicePublicKey,  // <-- NEW
  ...
});

// Sign challenge during key exchange
if (canUsePoP) {
  const signature = this.popCrypto!.signChallenge(challenge!);
  await this.exchangeKeys({
    uuid,
    deviceApiKey,
    signature  // <-- NEW
  });
}
```

### API Code Changes

**Modified Files:**
- `api/src/services/provisioning.service.ts` - Challenge generation
- `api/src/routes/provisioning.ts` - Signature verification
- `api/src/db/models.ts` - PoP database methods
- `api/database/migrations/121_add_proof_of_possession.sql` - Database schema

**Database Schema:**
```sql
ALTER TABLE devices
ADD COLUMN device_public_key TEXT,           -- PEM format Ed25519 public key
ADD COLUMN pop_verified BOOLEAN DEFAULT false,
ADD COLUMN pop_verified_at TIMESTAMP,
ADD COLUMN last_challenge TEXT,              -- Current nonce
ADD COLUMN last_challenge_expires_at TIMESTAMP;
```

## Testing

### Build Agent
```bash
cd agent
npm run build
```

### Deploy Agent
```bash
docker-compose up -d --build agent
# Or rebuild all agents
./scripts/generate-agents.ps1 -BuildFromSource -run
```

### Verify PoP in Logs

**Agent Logs** (successful PoP):
```
[info]: Registering with PoP public key
[info]: Using Ed25519 PoP signature
```

**API Logs** (successful PoP):
```
[info]: Received device registration with public key
[info]: Device registration includes public key for PoP
[info]: Generating PoP challenge for device
[info]: Attempting PoP verification with signature
[info]: Signature verification result { isValid: true }
[info]: PoP verification successful and persisted
```

**API Logs** (legacy fallback):
```
⚠️ Device registered without public key - using LEGACY authentication
⚠️ Using LEGACY bcrypt verification (not PoP)
  - Reason: device has no public key (not PoP-enabled)
```

### Database Verification

```sql
-- Check PoP status
SELECT 
  uuid,
  device_name,
  device_public_key IS NOT NULL as has_public_key,
  pop_verified,
  pop_verified_at
FROM devices
WHERE uuid = 'your-device-uuid';

-- Count PoP vs legacy devices
SELECT 
  pop_verified,
  COUNT(*) as count
FROM devices
GROUP BY pop_verified;
```

## Migration Path

### For New Devices

New devices automatically use PoP:
1. Agent generates Ed25519 key pair on first boot
2. Public key sent during registration
3. Challenge issued by API
4. Signature verified during key exchange
5. Device marked as `pop_verified=true`

### For Existing Devices

Existing devices continue using bcrypt until reprovisioned:

**Option 1: Reprovision (Recommended)**
```bash
# On device
docker exec -it <agent-container> /bin/sh
# Inside container
sqlite3 /app/data/device.sqlite "UPDATE device SET provisioned = 0, provisioningState = 'new'"
# Restart agent to reprovision with PoP
```

**Option 2: Keep Legacy**
Existing devices continue working with bcrypt - no action needed.

## Troubleshooting

### Agent Not Using PoP

**Symptom**: API logs show "Using LEGACY bcrypt verification"

**Check:**
```bash
# Verify PoP keys exist
docker exec <agent-container> cat /app/data/.pop-keys.json
# Should show: {"publicKey":"-----BEGIN PUBLIC KEY-----\n...","privateKey":"-----BEGIN PRIVATE KEY-----\n..."}
```

**Fix:**
```bash
# Rebuild agent with PoP support
cd agent && npm run build
docker-compose up -d --build agent
```

### Public Key Validation Fails

**Symptom**: API returns "Invalid public key format"

**Check:** Public key must be in PEM format:
```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----
```

### Signature Verification Fails

**Symptom**: API returns "Invalid signature"

**Possible Causes:**
1. Challenge expired (5-minute TTL)
2. Wrong challenge signed
3. Public/private key mismatch

**Debug:**
```bash
# Check agent logs for signing operation
docker logs <agent-container> | grep "Signing PoP challenge"

# Check API logs for verification
docker logs iotistic-api | grep "Signature verification result"
```

## Security Considerations

1. **Key Storage**: Private keys stored in `/app/data/.pop-keys.json` with 0600 permissions
2. **Challenge TTL**: 5 minutes prevents replay attacks
3. **Single-Use Challenges**: Challenge cleared after successful verification
4. **Immutable Public Key**: Cannot change after registration (prevents impersonation)
5. **No Key Transmission**: Private key never leaves device

## Future Enhancements

1. **Key Rotation**: Implement periodic key rotation with grace period
2. **Hardware Security**: Support HSM/TPM for private key storage
3. **Certificate Pinning**: Add server certificate validation
4. **mTLS**: Mutual TLS with client certificates
5. **Enforce PoP**: Disable bcrypt fallback after migration period
