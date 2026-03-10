# License Grace Period & Read-Only Mode Implementation

## Overview

This implementation provides a **14-day grace period** after trial expiry and **read-only mode** for historical data access after the grace period ends.

## Features

### 1. Grace Period (14 days default)
After a trial expires, users get 14 additional days of full access with warning headers.

**Configuration**:
```bash
# .env
LICENSE_GRACE_PERIOD_DAYS=14  # Configurable (default: 14)
```

### 2. Subscription States

The system now tracks four distinct states:

| State | Description | Access Level |
|-------|-------------|--------------|
| `active` | Paid subscription active | Full access |
| `trial_active` | Trial period, not yet expired | Full access |
| `trial_grace` | Trial expired, within grace period | Full access + warnings |
| `expired` | Grace period ended | Read-only or blocked |

### 3. Read-Only Mode

After grace period expires, read-only mode allows:
- ✅ GET requests (view devices, metrics, dashboards)
- ❌ POST/PUT/DELETE (no writes, no device creation)

## API Methods

### License Validator Methods

```typescript
import { LicenseValidator } from '../services/license-validator';

const license = LicenseValidator.getInstance();

// Check if subscription is active (includes grace period)
const isActive = license.isSubscriptionActive();
// true for: active, trial_active, trial_grace
// false for: expired

// Get detailed subscription state
const state = license.getSubscriptionState();
// Returns: 'active' | 'trial_active' | 'trial_grace' | 'expired'

// Get grace period days remaining (null if not in grace)
const daysLeft = license.getGracePeriodDaysRemaining();
// Returns: number | null
```

## Middleware Usage

### Old Middleware (Still Supported)

```typescript
import { requireActiveSubscription } from '../middleware/feature-guard';

// Simple check: block if not active (no grace period handling)
router.post('/api/devices', requireActiveSubscription, async (req, res) => {
  // Only allows if status === 'active' or 'trialing'
});
```

### New Middleware (Recommended)

```typescript
import { requireValidSubscription } from '../middleware/feature-guard';

// Mode: 'strict' - Block after grace period (default)
router.post('/api/devices', requireValidSubscription('strict'), async (req, res) => {
  // Allows: active, trial_active, trial_grace
  // Blocks: expired
});

// Mode: 'read-only' - Allow GET after grace period, block writes
router.use('/api/metrics', requireValidSubscription('read-only'));
// GET /api/metrics -> ✅ Works even when expired
// POST /api/metrics -> ❌ Blocked when expired

// Mode: 'graceful' - Always allow with warnings
router.get('/api/health', requireValidSubscription('graceful'), async (req, res) => {
  // Always allows, adds warning headers during grace/expired
});
```

## Response Headers

During grace period or after expiry, the middleware adds informative headers:

```http
X-Subscription-Warning: Trial expired. 12 days remaining in grace period.
X-Subscription-State: trial_grace
X-Grace-Days-Remaining: 12
X-Subscription-Status: read-only
```

## Example Route Configuration

```typescript
import { requireValidSubscription } from '../middleware/feature-guard';
import express from 'express';

const router = express.Router();

// Read operations: Allow even after expiry (historical data access)
router.get('/api/devices', requireValidSubscription('read-only'), listDevices);
router.get('/api/metrics', requireValidSubscription('read-only'), getMetrics);
router.get('/api/dashboards', requireValidSubscription('read-only'), getDashboards);

// Write operations: Block after grace period
router.post('/api/devices', requireValidSubscription('strict'), createDevice);
router.put('/api/devices/:id', requireValidSubscription('strict'), updateDevice);
router.delete('/api/devices/:id', requireValidSubscription('strict'), deleteDevice);

// Billing/upgrade: Always allow (no license check needed)
router.post('/api/billing/upgrade', upgradeSubscription);
router.get('/api/billing/status', getBillingStatus);

// Health checks: Always allow with warnings
router.get('/api/health', requireValidSubscription('graceful'), healthCheck);
```

## Error Responses

### Expired (Strict Mode)
```json
{
  "error": "Subscription expired",
  "message": "Your trial has expired. Upgrade to continue using the platform.",
  "state": "expired",
  "plan": "starter",
  "trialExpiresAt": "2025-11-04T23:53:08.536Z",
  "upgradeUrl": "https://iotistic.ca/upgrade",
  "billingUrl": "https://iotistic.ca/billing"
}
```
**Status Code**: `402 Payment Required`

### Expired (Read-Only Mode, Write Attempt)
```json
{
  "error": "Subscription expired",
  "message": "Your trial has expired. Write operations are disabled. Upgrade to continue.",
  "state": "expired",
  "plan": "starter",
  "trialExpiresAt": "2025-11-04T23:53:08.536Z",
  "upgradeUrl": "https://iotistic.ca/upgrade",
  "billingUrl": "https://iotistic.ca/billing"
}
```
**Status Code**: `402 Payment Required`

### Grace Period (Warning Headers Only)
```http
HTTP/1.1 200 OK
X-Subscription-Warning: Trial expired. 7 days remaining in grace period.
X-Subscription-State: trial_grace
X-Grace-Days-Remaining: 7
Content-Type: application/json

{
  "devices": [/* ... */]
}
```

## Logging

The system logs subscription state during initialization:

### Trial Active
```
[info]: License validated successfully {...}
[info]: Trial mode active {"daysRemaining":5,"trialExpiresAt":"2025-11-04T23:53:08.536Z"}
```

### Trial Expired (Grace Period)
```
[info]: License validated successfully {...}
[warn]: Trial expired {"trialExpiresAt":"2025-11-04T23:53:08.536Z","daysExpired":3,"subscriptionStatus":"trialing"}
```

## Testing

### Test with Different States

```bash
# Set grace period to 0 for immediate expiry testing
LICENSE_GRACE_PERIOD_DAYS=0

# Set grace period to 30 for extended testing
LICENSE_GRACE_PERIOD_DAYS=30
```

### Manual Testing

```bash
# Check subscription state
curl http://localhost:4002/api/license/verify

# Test read-only mode (GET should work when expired)
curl http://localhost:4002/api/devices

# Test write block (POST should fail when expired)
curl -X POST http://localhost:4002/api/devices \
  -H "Content-Type: application/json" \
  -d '{"name":"test"}'
```

## Best Practices

### 1. Route Design
- **Read endpoints**: Use `read-only` mode for historical data access
- **Write endpoints**: Use `strict` mode to prevent operations after expiry
- **Billing/upgrade**: Never gate with license checks
- **Health checks**: Use `graceful` mode

### 2. Client-Side Handling
- Check `X-Subscription-State` header in responses
- Show upgrade prompts during `trial_grace` state
- Display read-only banner when `X-Subscription-Status: read-only`

### 3. MQTT Handling
```typescript
// mqtt/connection-handler.ts
const state = license.getSubscriptionState();

if (state === 'trial_grace') {
  client.publish('$device/warning', JSON.stringify({
    type: 'subscription_expiring',
    daysRemaining: license.getGracePeriodDaysRemaining(),
  }));
}

if (state === 'expired') {
  client.publish('$device/warning', JSON.stringify({
    type: 'subscription_expired',
    message: 'Device data will not be processed.',
  }));
  client.disconnect();
}
```

### 4. Background Jobs
```typescript
// Schedule daily check for expiring subscriptions
async function checkSubscriptionExpiry() {
  const license = LicenseValidator.getInstance();
  const state = license.getSubscriptionState();
  
  if (state === 'trial_grace') {
    const daysLeft = license.getGracePeriodDaysRemaining();
    await sendEmail({
      subject: `Action required: ${daysLeft} days until service suspension`,
      template: 'trial-grace-period',
    });
  }
}
```

## Migration Guide

### Existing Code

If you're using `requireActiveSubscription`, it now includes grace period handling:

**Before**:
```typescript
// Blocked immediately when trial expires
router.post('/api/devices', requireActiveSubscription, handler);
```

**After (same behavior)**:
```typescript
// Blocked after grace period
router.post('/api/devices', requireActiveSubscription, handler);
```

### New Features

To leverage read-only mode:

```typescript
// Old: Hard block after trial
router.get('/api/metrics', requireActiveSubscription, handler);

// New: Allow viewing metrics even after trial
router.get('/api/metrics', requireValidSubscription('read-only'), handler);
```

## Security Considerations

1. **Grace period is not infinite**: After 14 days, full lockout occurs
2. **Read-only mode is enforced**: Only GET requests allowed
3. **Billing endpoints exempt**: Users can always upgrade
4. **JWT expiry still enforced**: Grace period doesn't extend JWT lifetime

## Environment Variables

```bash
# Required
IOTISTIC_LICENSE_KEY=<jwt-token>
LICENSE_PUBLIC_KEY=<rsa-public-key>

# Optional
LICENSE_GRACE_PERIOD_DAYS=14  # Default: 14 days
BILLING_UPGRADE_URL=https://iotistic.ca/upgrade
BILLING_PORTAL_URL=https://iotistic.ca/billing
```

## Implementation Checklist

- [x] Fix `isSubscriptionActive()` to check trial expiry
- [x] Add `getSubscriptionState()` method
- [x] Add `getGracePeriodDaysRemaining()` method
- [x] Create `requireValidSubscription()` middleware with modes
- [x] Add grace period warning headers
- [x] Implement read-only mode (GET-only)
- [x] Add configurable `LICENSE_GRACE_PERIOD_DAYS`
- [x] Update logging for trial expired state
- [ ] Apply to API routes (as needed)
- [ ] Add MQTT disconnect on expiry (optional)
- [ ] Implement email notifications (future)

## Future Enhancements

1. **Automated notifications**: Email alerts at 7, 3, 1 days before trial expiry
2. **Progressive degradation**: Reduce features gradually during grace period
3. **Usage tracking**: Monitor API calls during read-only mode
4. **Custom grace periods**: Per-plan grace period configuration
5. **Dashboard banner**: Show trial status prominently in UI
