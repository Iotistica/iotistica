# Cloud API Provisioning Endpoint Updates

## Summary

All necessary changes have been implemented to support the device-side provisioning security hardening. The cloud API now supports:

✅ **X-Idempotency-Key Support** - Safe retries with cached responses
✅ **UUID Immutability Validation** - Prevents re-provisioning after registration
✅ **API Key Version Support** - Handles v1 (legacy) and v2 (recommended) formats
✅ **Provisioning Challenge Generation** - Foundation for proof-of-possession
✅ **Challenge-Response Caching** - Redis-backed challenge management

---

## What Changed

### 1. **New Utility Modules**

#### `api/src/utils/idempotency.ts` (NEW)
Handles idempotency key caching for safe retries:
- `checkIdempotencyKey(key)` - Returns cached response if request already processed
- `cacheIdempotencyKey(key, response, ttl)` - Store response for 24 hours
- `cacheProvisioningChallenge(uuid, challenge, ttl)` - Store challenge for 5 minutes
- `getProvisioningChallenge(uuid)` - Retrieve and delete challenge (one-time use)

**Storage**: Redis with automatic TTL cleanup
**TTL**: 24 hours for idempotency keys, 5 minutes for challenges

#### `api/src/utils/proof-of-possession.ts` (NEW)
Cryptographic utilities for secure key exchange:
- `generateChallenge()` - 64-char random hex challenge
- `parseApiKey(key)` - Extract version, kid, and secret from v1/v2 keys
- `verifyProofOfPossession(challenge, uuid, proof, secret)` - Constant-time HMAC verification
- `computeProofOfPossession(challenge, uuid, secret)` - Compute proof for testing

**Security**: Uses `crypto.timingSafeEqual()` for timing attack protection

---

### 2. **Updated Provisioning Routes** (`api/src/routes/provisioning.ts`)

#### POST `/api/v1/device/register`

**New Features**:
- ✅ Accepts `X-Idempotency-Key: register-{uuid}` header
- ✅ Checks Redis cache before processing (prevents duplicate registrations on retry)
- ✅ Returns `challenge` field in response for proof-of-possession
- ✅ Caches challenge in Redis for use in key-exchange phase

**Request**:
```typescript
POST /api/v1/device/register
X-Idempotency-Key: register-{uuid}  // NEW: Safe retry support
Authorization: Bearer <provisioning_api_key>
Content-Type: application/json

{
  "uuid": "device-uuid-here",
  "deviceName": "My Device",
  "deviceType": "raspberry-pi",
  "deviceApiKey": "v2_k1a2b3c4_64hex_chars_here...",  // v1 or v2 format
  "macAddress": "AA:BB:CC:DD:EE:FF",
  "osVersion": "Ubuntu 22.04",
  "agentVersion": "2.0.0"
}
```

**Response**:
```typescript
{
  "id": 42,
  "uuid": "device-uuid-here",
  "challenge": "64_hex_chars_here",  // NEW: For proof-of-possession in key-exchange
  "mqtt": {
    "username": "device_uuid",
    "password": "mqtt_password",
    "broker": "mqtt.example.com:1883",
    "topics": { /* ... */ }
  },
  "vpn": { /* ... */ }
}
```

---

#### POST `/api/v1/device/:uuid/key-exchange`

**New Features**:
- ✅ Accepts `X-Idempotency-Key: key-exchange-{uuid}` header
- ✅ Checks Redis cache before processing
- ✅ Validates deviceApiKey against bcrypt hash (as before)
- ✅ Supports proof-of-possession verification (foundation for future upgrade)
- ✅ Logs auth method used (bcrypt vs proof-of-possession)

**Request**:
```typescript
POST /api/v1/device/:uuid/key-exchange
X-Idempotency-Key: key-exchange-{uuid}  // NEW: Safe retry support
Authorization: Bearer <device_api_key>
Content-Type: application/json

{
  "deviceApiKey": "v2_k1a2b3c4_64hex_chars_here..."  // Device API key
}
```

**Response**:
```typescript
{
  "status": "ok",
  "message": "Key exchange successful",
  "device": {
    "id": 42,
    "uuid": "device-uuid-here",
    "deviceName": "My Device"
  }
}
```

---

### 3. **Updated Provisioning Service** (`api/src/services/provisioning.service.ts`)

**New Features**:
- ✅ Parses and validates versioned API keys (v1 and v2)
- ✅ Improved UUID immutability error message: "Device already registered with this UUID. Factory reset to re-provision."
- ✅ Imports proof-of-possession utilities for future expansion

**Changes**:
```typescript
// Before: Just hashed the key
await bcrypt.hash(deviceApiKey, 10)

// After: Parse key version, validate format, then hash
const parsedKey = parseApiKey(deviceApiKey);  // Validates v1 or v2 format
logger.info(`Device using API key version: ${parsedKey.version}${parsedKey.kid ? ` (kid: ${parsedKey.kid})` : ''}`);
await bcrypt.hash(deviceApiKey, 10);  // Still hash for backward compatibility
```

---

## Security Improvements

### 1. **Idempotency Key Safety**

**Problem**: Device retrying on timeout creates duplicate devices
**Solution**: X-Idempotency-Key header with 24-hour cache

```
Device sends retry with same idempotency key
  ↓
API checks Redis cache: idempotency:{key}
  ↓
If found: Return cached response (no duplicate)
If not found: Process request, cache result
```

**Device Format**: `register-{uuid}` and `key-exchange-{uuid}`

### 2. **UUID Immutability**

**Problem**: Device could be re-provisioned with different UUID post-registration
**Solution**: Check UUID uniqueness, prevent changes after registration

```typescript
// In registerDevice():
const existingDevice = await DeviceModel.getByUuid(uuid);
if (existingDevice && existingDevice.provisioning_state === 'registered') {
  throw new Error('Device already registered with this UUID. Factory reset to re-provision.');
}
```

### 3. **Challenge-Response Foundation**

**Problem**: Proof-of-possession requires challenge storage
**Solution**: Redis-backed challenge caching

```typescript
// During registration:
const challenge = generateChallenge();  // 64-char random hex
await cacheProvisioningChallenge(uuid, challenge);  // 5-min TTL

// During key-exchange:
const challenge = await getProvisioningChallenge(uuid);  // One-time use, auto-deleted
// Verify: HMAC-SHA256(deviceApiKey.secret, challenge:uuid) == proof
```

### 4. **API Key Version Support**

**Problem**: Device sends versioned keys, API doesn't validate format
**Solution**: Parse and validate v1/v2 keys

```typescript
const { version, kid, secret } = parseApiKey(deviceApiKey);
// v1: 64 hex chars (legacy)
// v2: v2_kid_secret (8 hex kid + 64 hex secret)
```

---

## Implementation Details

### Redis Cache Keys

```
idempotency:{idempotencyKey}      // 24-hour TTL
  Value: Full JSON response

challenge:{uuid}                   // 5-minute TTL
  Value: 64-char hex challenge string
```

### Error Messages

**Device already registered**:
```json
{
  "error": "Failed to register device",
  "message": "Device already registered with this UUID. Factory reset to re-provision."
}
```

**Missing idempotency key**: None (cached automatically if provided)

**Challenge expired**:
```json
{
  "error": "Authentication failed",
  "message": "Challenge expired. Please restart registration."
}
```

---

## Testing Endpoints

### 1. Test Idempotency (Register)

```bash
# First request
curl -X POST http://localhost:3002/api/v1/device/register \
  -H "X-Idempotency-Key: register-test-uuid-123" \
  -H "Authorization: Bearer <provisioning_key>" \
  -H "Content-Type: application/json" \
  -d '{"uuid":"test-uuid-123","deviceName":"Test","deviceType":"test","deviceApiKey":"v2_k1a2b3c4_'$(python3 -c 'import secrets; print(secrets.token_hex(32))')'"}'

# Retry with same idempotency key - should get cached response
curl -X POST http://localhost:3002/api/v1/device/register \
  -H "X-Idempotency-Key: register-test-uuid-123" \
  -H "Authorization: Bearer <provisioning_key>" \
  -H "Content-Type: application/json" \
  -d '{"uuid":"test-uuid-123","deviceName":"Test","deviceType":"test","deviceApiKey":"v2_k1a2b3c4_'$(python3 -c 'import secrets; print(secrets.token_hex(32))')'"}'
```

### 2. Test UUID Immutability

```bash
# Try to re-register device with same UUID
curl -X POST http://localhost:3002/api/v1/device/register \
  -H "Authorization: Bearer <provisioning_key>" \
  -H "Content-Type: application/json" \
  -d '{"uuid":"test-uuid-123","deviceName":"Test2","deviceType":"test","deviceApiKey":"different_key_here"}'

# Should fail with: "Device already registered with this UUID. Factory reset to re-provision."
```

### 3. Test API Key Versions

```bash
# V2 format (recommended)
{
  "deviceApiKey": "v2_k1a2b3c4_64_hex_chars_representing_256bit_key_here..."
}

# V1 format (legacy)
{
  "deviceApiKey": "64_hex_chars_representing_256bit_key_here..."
}
```

---

## Future Enhancements

### Proof-of-Possession (Phase 2)

**Currently**: Challenge is generated and cached, but verification falls back to bcrypt
**Future**: Store API key secret to enable true HMAC-SHA256 verification

**Changes needed**:
1. Add `device_api_key_secret` column to devices table
2. Store secret separately from hash
3. Implement true `verifyProofOfPossession()` in key-exchange endpoint
4. Delete secret after first successful key-exchange

---

## Backward Compatibility

✅ **Full backward compatibility maintained**:
- Idempotency key is optional (falls back to normal processing)
- Both v1 and v2 API key formats supported
- Legacy bcrypt comparison still works
- All existing device registrations continue to work

---

## Files Modified

1. ✅ `api/src/routes/provisioning.ts` - Added idempotency support to both endpoints
2. ✅ `api/src/services/provisioning.service.ts` - Added API key version validation and improved error messages
3. ✅ `api/src/utils/idempotency.ts` (NEW) - Idempotency key management
4. ✅ `api/src/utils/proof-of-possession.ts` (NEW) - Challenge and HMAC utilities

---

## Verification

✅ **Type checking**: `npm run build` passes with no errors
✅ **Imports**: All dependencies properly imported
✅ **Error handling**: Comprehensive error messages and logging
✅ **Audit trail**: All events logged with device UUID, IP, and method used

---

## Next Steps

1. **Testing**: Run provisioning flow with device
2. **Monitoring**: Check Redis cache hit rates for idempotency keys
3. **Phase 2**: Implement full proof-of-possession with API key secret storage
4. **Documentation**: Update provisioning API docs with new headers and response fields
