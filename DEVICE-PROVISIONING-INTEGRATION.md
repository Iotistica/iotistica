# Device-Side Provisioning Integration Guide

## Summary

The device-side provisioning code is already complete and compatible with the updated cloud API. This document shows how the device interacts with the new provisioning endpoints.

---

## Phase 1: Device Registration

### What Device Sends

```typescript
POST /api/v1/device/register
X-Idempotency-Key: register-{uuid}  // CRITICAL: Safe retries
Authorization: Bearer <provisioning_api_key>
Content-Type: application/json

{
  "uuid": "a1b2c3d4-e5f6-...",
  "deviceName": "My Raspberry Pi",
  "deviceType": "raspberry-pi",
  "deviceApiKey": "v2_k1a2b3c4_64_hex_chars_here...",
  "macAddress": "AA:BB:CC:DD:EE:FF",
  "osVersion": "Ubuntu 22.04",
  "agentVersion": "2.0.0"
}
```

### What Device Receives

```typescript
{
  "id": 42,
  "uuid": "a1b2c3d4-e5f6-...",
  "challenge": "64_hex_chars_here",  // NEW: For proof-of-possession
  "mqtt": {
    "username": "device_a1b2c3d4",
    "password": "mqtt_password_here",
    "broker": "mqtt.example.com:1883",
    "brokerConfig": { /* ... */ },
    "topics": {
      "publish": ["sensor/temperature", "sensor/humidity", ...],
      "subscribe": ["commands/update", ...]
    }
  },
  "vpn": { /* ... */ },
  "api": { /* ... */ }
}
```

### Device-Side Implementation

The device-side is already complete in `agent/src/provisioning/device-manager.ts`:

✅ **Generates v2 API keys**: `v2_kid_secret` format with 8-char kid + 64-char secret
✅ **Sends X-Idempotency-Key**: `register-{uuid}` format for safe retries
✅ **Exponential backoff**: 6 attempts, 1s-32s delays, 30s timeout per attempt
✅ **Stores challenge**: Caches challenge from response for key-exchange phase
✅ **Transparent retry**: Retries automatically on timeout with idempotency protection

---

## Phase 2: Key Exchange

### What Device Sends

**Current Flow** (Already implemented):
```typescript
POST /api/v1/device/{uuid}/key-exchange
X-Idempotency-Key: key-exchange-{uuid}  // NEW: Safe retries
Authorization: Bearer <device_api_key>
Content-Type: application/json

{
  "deviceApiKey": "v2_k1a2b3c4_64_hex_chars_here..."
}
```

**Future Flow** (Proof-of-Possession - Phase 2):
```typescript
POST /api/v1/device/{uuid}/key-exchange
X-Idempotency-Key: key-exchange-{uuid}
Authorization: Bearer <device_api_key>
Content-Type: application/json

{
  "proof": "hmac_sha256_signature_here"  // HMAC(secret, challenge:uuid)
}
```

### What Device Receives

```typescript
{
  "status": "ok",
  "message": "Key exchange successful",
  "device": {
    "id": 42,
    "uuid": "a1b2c3d4-e5f6-...",
    "deviceName": "My Raspberry Pi"
  }
}
```

### Device-Side Implementation

The device side is already complete in `agent/src/provisioning/device-manager.ts`:

✅ **Sends X-Idempotency-Key**: `key-exchange-{uuid}` format for safe retries
✅ **Wrapped with retryWithBackoff**: Handles timeouts and retries automatically
✅ **Fallback support**: Falls back to v1 format if v2 not supported
✅ **Transparent error handling**: Logs failures and retries with exponential backoff

---

## Error Handling

### Device Already Registered

**Error Response**:
```json
{
  "error": "Failed to register device",
  "message": "Device already registered with this UUID. Factory reset to re-provision."
}
```

**Device Action**:
- Device detects this error code (409 Conflict or 400 Bad Request with specific message)
- User must run `factory reset` command on device
- Device erases provisioning data and local state
- User can then re-run provisioning

### Challenge Expired

**Error Response**:
```json
{
  "error": "Authentication failed",
  "message": "Challenge expired. Please restart registration."
}
```

**Device Action**:
- Device starts from Phase 1 (registration) again
- Idempotency key prevents duplicate device creation
- Gets new challenge from registration response

### Timeout with Retries

**Device Behavior** (Already implemented):
1. Device calls register endpoint
2. Timeout after 30 seconds → retry automatically
3. Use same X-Idempotency-Key: `register-{uuid}`
4. Cloud API checks Redis: "Oh, I already processed this"
5. Returns cached response → Device proceeds
6. No duplicate devices created ✅

---

## Retry Flow Visualization

```
Device                                    Cloud API
  │                                           │
  ├──register-{uuid}──────────────────────────>
  │  (X-Idempotency-Key: register-uuid)      │
  │                                       Process req
  │                                      Store cache
  │  <────────response with challenge────────┤
  │                                           │
  │ Timeout! Retry...                        │
  │                                           │
  ├──register-{uuid}──────────────────────────>
  │  (same X-Idempotency-Key)                │
  │                                    Check Redis
  │                                      Cache hit!
  │  <────cached response────────────────────┤
  │                                           │
  ✅ No duplicate device                     │
```

---

## API Key Format Support

### V2 Format (Recommended)

**Format**: `v2_{8-hex-kid}_{64-hex-secret}`
**Example**: `v2_k1a2b3c4_a1b2c3d4e5f6...` (total 77 chars)

**Benefits**:
- Key ID (kid) enables rotation strategies
- 64-char secret = 32 bytes = 256-bit security
- Future-proof for format evolution

**Device Generation** (Already implemented):
```typescript
const kid = crypto.randomBytes(4).toString('hex');  // 8 hex chars
const secret = crypto.randomBytes(32).toString('hex');  // 64 hex chars
const apiKey = `v2_${kid}_${secret}`;
```

### V1 Format (Legacy Support)

**Format**: 64 hex characters directly
**Example**: `a1b2c3d4e5f6...` (64 chars)

**Support**:
- Cloud API still accepts and hashes v1 keys
- Authentication works normally
- New devices should use v2

---

## Testing Checklist

### ✅ Device Registration
- [ ] Device generates v2 API key successfully
- [ ] Device sends X-Idempotency-Key: `register-{uuid}`
- [ ] Cloud API returns 200 with challenge
- [ ] Device caches challenge for key-exchange phase
- [ ] Device retries with same idempotency key (simulated timeout)
- [ ] Cloud API returns cached response (no duplicate device created)

### ✅ Key Exchange
- [ ] Device sends X-Idempotency-Key: `key-exchange-{uuid}`
- [ ] Cloud API validates deviceApiKey against hash
- [ ] Cloud API returns 200 with device info
- [ ] Device retries with same idempotency key
- [ ] Cloud API returns cached response (no duplicate auth)

### ✅ Error Cases
- [ ] Device handles "already registered" error
- [ ] Device handles "challenge expired" error
- [ ] Device handles timeout and retries automatically
- [ ] Device logs all retry attempts

---

## Backward Compatibility

### Device Running Old Code

**V1 API Keys** (still work):
- Cloud API accepts 64-char hex keys
- bcrypt comparison still works
- No X-Idempotency-Key header needed (but works if sent)

**Migration Path**:
1. Old devices continue working with v1 keys
2. New devices use v2 keys
3. Both formats work simultaneously
4. No breaking changes

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Device registration | ✅ Complete | Generates v2 keys, sends idempotency key |
| Key exchange | ✅ Complete | Sends idempotency key, handles retries |
| Retry logic | ✅ Complete | 6 attempts, exponential backoff, 30s timeout |
| UUID immutability | ✅ Complete | Device prevents UUID changes after provisioning |
| Cloud API registration | ✅ Complete | Validates keys, checks idempotency, returns challenge |
| Cloud API key-exchange | ✅ Complete | Verifies key, supports idempotency, caches result |
| Challenge generation | ✅ Complete | Cloud generates 64-char random challenge |
| Challenge caching | ✅ Complete | Redis caches challenge for 5 minutes |
| Idempotency caching | ✅ Complete | Redis caches responses for 24 hours |

---

## Monitoring

### Health Check

**Device Health**:
```bash
curl http://device-ip:48484/v2/device/status
# Check provisioning_state = "registered"
# Check uuid_locked = true
```

**Cloud API Health**:
```bash
# Check Redis cache hits
redis-cli INFO stats  # total_commands_processed

# Monitor idempotency cache usage
redis-cli KEYS "idempotency:*" | wc -l

# Monitor challenge cache usage
redis-cli KEYS "challenge:*" | wc -l
```

---

## Next Steps

1. **Deploy**: Push updated API code to production
2. **Monitor**: Watch Redis cache performance and idempotency hit rates
3. **Phase 2**: Implement full proof-of-possession (requires storing API key secret)
4. **Document**: Update API documentation with new headers and response fields

---

## Questions?

See [PROVISIONING-API-UPDATES.md](./PROVISIONING-API-UPDATES.md) for complete API documentation and testing examples.
