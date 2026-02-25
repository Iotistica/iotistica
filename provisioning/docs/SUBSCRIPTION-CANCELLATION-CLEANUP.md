# Subscription Cancellation & Cleanup Flow

## Overview

This document describes how the system handles subscription cancellation via Stripe webhooks and the automated cleanup process that follows.

## Webhook Event: `customer.subscription.deleted`

When a customer cancels their subscription (or it's canceled by an admin in Stripe Dashboard), Stripe sends a `customer.subscription.deleted` webhook event.

### Handler Location

**File**: `billing/src/services/stripe-service.ts`  
**Method**: `handleSubscriptionDeleted()`

### Automatic Actions

When the webhook is received, the system automatically:

1. ✅ **Updates Subscription Status**
   - Sets subscription status to `canceled` in database
   - Logs cancellation timestamp

2. 🗑️ **Queues K8s Cleanup Job**
   - Adds `delete-customer-stack` job to Bull queue
   - Job parameters:
     - `customerId`: Customer identifier
     - `namespace`: K8s namespace (e.g., `customer-a1b2c3d4`)
     - `reason`: `subscription_deleted`
   - Retry configuration: 3 attempts with exponential backoff

3. 🚫 **Deactivates Customer**
   - Sets `is_active = false` in customers table
   - Sets `deleted_at` timestamp
   - Prevents further API access

## Cleanup Process

### Phase 1: Immediate Cleanup (Webhook Handler)

```typescript
// Triggered by: customer.subscription.deleted webhook
await SubscriptionModel.cancel(customerId);
await deploymentQueue.add('delete-customer-stack', {
  customerId,
  namespace: `customer-${customerId.substring(5, 13)}`,
  reason: 'subscription_deleted',
});
await pool.query('UPDATE customers SET is_active = false, deleted_at = NOW() ...');
```

### Phase 2: K8s Resource Deletion (Deployment Worker)

**Worker**: `billing/src/workers/deployment-worker.ts`  
**Job Type**: `delete-customer-stack`

The deployment worker processes the cleanup job:

```typescript
// Deletes K8s namespace and all resources
const result = await k8sDeploymentService.deleteCustomerInstance(customerId);

// Resources deleted:
// - Namespace (customer-*)
// - All pods (API, Mosquitto, PostgreSQL, Dashboard, Billing Exporter)
// - Services and ServiceMonitors
// - ConfigMaps and Secrets
// - PersistentVolumeClaims (data volumes)
```

### Phase 3: Data Retention (Optional)

For advanced cleanup with retention period, use the `CustomerDeactivationService`:

```typescript
import { CustomerDeactivationService } from './services/customer-deactivation';

await CustomerDeactivationService.deactivateCustomer(customerId, {
  cancelSubscription: true,
  issueRefund: false,
  deleteData: true,
  retentionDays: 30, // Keep data for 30 days before permanent deletion
  cancelAtPeriodEnd: false,
});
```

**File**: `billing/src/services/customer-deactivation.ts`

## Cancellation Scenarios

### Scenario 1: Customer Cancels via Stripe Dashboard

```
1. Customer clicks "Cancel" in Stripe Dashboard
2. Stripe sends customer.subscription.deleted webhook
3. handleSubscriptionDeleted() runs
4. Subscription marked canceled
5. K8s cleanup job queued
6. Customer deactivated (is_active = false)
7. Deployment worker deletes namespace
8. All resources removed within ~5 minutes
```

### Scenario 2: Admin Cancels Subscription

```
1. Admin cancels subscription in Stripe
2. Same webhook flow as Scenario 1
3. Automatic cleanup triggered
```

### Scenario 3: Payment Failure → Subscription Deleted

```
1. Payment fails multiple times
2. Stripe automatically cancels subscription
3. customer.subscription.deleted webhook sent
4. Cleanup flow triggered
```

### Scenario 4: Graceful Cancellation (Cancel at Period End)

```
1. Customer requests cancellation via API
2. API calls: StripeService.cancelAtPeriodEnd(customerId)
3. Subscription marked for cancellation at period end
4. Customer continues access until end date
5. At period end: customer.subscription.deleted webhook
6. Cleanup flow triggered (resources removed)
```

## API Endpoints

### Cancel Subscription (Graceful)

```bash
DELETE /api/customers/:id/subscription?cancelAtPeriodEnd=true
```

**Response**:
```json
{
  "success": true,
  "message": "Subscription will be canceled at period end",
  "cancelAt": "2025-11-30T23:59:59Z"
}
```

### Cancel Subscription (Immediate)

```bash
DELETE /api/customers/:id/subscription
```

**Response**:
```json
{
  "success": true,
  "message": "Subscription canceled immediately",
  "cleanupJobId": "12345"
}
```

### Deactivate Customer (Full Cleanup)

```bash
DELETE /api/customers/:id
```

**Body**:
```json
{
  "cancelSubscription": true,
  "issueRefund": false,
  "deleteData": true,
  "retentionDays": 30
}
```

**Response**:
```json
{
  "customerId": "cust_abc123",
  "subscriptionCanceled": true,
  "refundIssued": false,
  "dataScheduledForDeletion": true,
  "scheduledDeletionDate": "2025-11-30T00:00:00Z",
  "licenseRevoked": true
}
```

## Monitoring

### Bull Board (Job Queue)

Monitor cleanup jobs at: **http://localhost:3100/admin/queues**

- View `delete-customer-stack` jobs
- Check job progress and failures
- Retry failed jobs manually

### Database Queries

**Check subscription status**:
```sql
SELECT customer_id, plan, status, current_period_ends_at, updated_at
FROM subscriptions
WHERE customer_id = 'cust_abc123';
```

**Check customer status**:
```sql
SELECT customer_id, email, is_active, deleted_at, instance_namespace
FROM customers
WHERE customer_id = 'cust_abc123';
```

**Check cleanup queue**:
```sql
SELECT * FROM cleanup_queue
WHERE customer_id = 'cust_abc123';
```

### K8s Verification

**Check namespace exists**:
```bash
kubectl get namespace customer-a1b2c3d4
```

**Watch namespace deletion**:
```bash
kubectl get namespace customer-a1b2c3d4 --watch
```

**View cleanup events**:
```bash
kubectl get events -n customer-a1b2c3d4 --sort-by='.lastTimestamp'
```

## Testing

### Test Subscription Cancellation Flow

Use the provided test script:

```powershell
# Test immediate cancellation
.\billing\scripts\test-cancellation-flow.ps1 -CustomerId "cust_abc123"

# Test graceful cancellation (cancel at period end)
.\billing\scripts\test-cancellation-flow.ps1 -CustomerId "cust_abc123" -CancelAtPeriodEnd
```

### Manual Webhook Testing

Simulate Stripe webhook locally:

```powershell
# Trigger subscription.deleted webhook
curl -X POST http://localhost:3100/api/webhooks/stripe `
  -H "Content-Type: application/json" `
  -H "stripe-signature: $signature" `
  -d '{
    "type": "customer.subscription.deleted",
    "data": {
      "object": {
        "id": "sub_abc123",
        "customer": "cus_stripe123",
        "status": "canceled"
      }
    }
  }'
```

**Note**: Requires valid Stripe signature. Use Stripe CLI for testing:

```bash
stripe listen --forward-to localhost:3100/api/webhooks/stripe
stripe trigger customer.subscription.deleted
```

## Troubleshooting

### Issue: Webhook Received but Cleanup Not Triggered

**Check**:
1. Verify subscription exists in database:
   ```sql
   SELECT * FROM subscriptions WHERE stripe_subscription_id = 'sub_abc123';
   ```
2. Check Bull queue for job:
   ```bash
   curl http://localhost:3100/admin/queues/api
   ```
3. View deployment worker logs:
   ```bash
   docker compose logs billing -f | grep "delete-customer-stack"
   ```

### Issue: K8s Namespace Not Deleted

**Check**:
1. View job status in Bull Board
2. Check worker logs for errors
3. Verify namespace exists:
   ```bash
   kubectl get namespace | grep customer-
   ```
4. Manually delete if stuck:
   ```bash
   kubectl delete namespace customer-a1b2c3d4 --force --grace-period=0
   ```

### Issue: Customer Still Active After Cancellation

**Fix**:
```sql
UPDATE customers 
SET is_active = false, 
    deleted_at = NOW() 
WHERE customer_id = 'cust_abc123';
```

## Data Retention Policy

### Immediate Deletion (Default)

- **Subscription canceled** → K8s namespace deleted within 5 minutes
- **All data lost**: Devices, MQTT data, configurations, dashboards

### Retention Period (Advanced)

Use `CustomerDeactivationService` for retention:

```typescript
await CustomerDeactivationService.deactivateCustomer(customerId, {
  deleteData: true,
  retentionDays: 30, // Keep data for 30 days
});
```

**Schedule**:
- Day 0: Subscription canceled, customer deactivated
- Day 1-30: Data retained, customer can be reactivated
- Day 31: Permanent deletion (cron job)

**Reactivation** (within retention period):
```typescript
await CustomerDeactivationService.reactivateCustomer(customerId);
```

### Permanent Deletion

Scheduled via cron job:

```bash
# Run daily at 2 AM
cron: "0 2 * * *"
command: npm run cleanup:execute-deletions
```

**Implementation**:
```typescript
// billing/src/services/customer-deactivation.ts
await CustomerDeactivationService.executeScheduledDeletions();
```

## Security Considerations

1. **Webhook Signature Verification**: Always verify Stripe signature
2. **Idempotency**: Handle duplicate webhook events gracefully
3. **Audit Logging**: Log all cancellation events
4. **Data Backup**: Consider backing up critical data before deletion
5. **GDPR Compliance**: Support "right to be forgotten" requests

## Related Documentation

- **Stripe Dashboard Customer Flow**: `billing/docs/STRIPE-DASHBOARD-CUSTOMER-FLOW.md`
- **Customer Deletion System**: `docs/CUSTOMER-DELETION-SYSTEM.md`
- **Deployment Queue**: `docs/DEPLOYMENT-QUEUE-GUIDE.md`
- **K8s Deployment Guide**: `docs/K8S-DEPLOYMENT-GUIDE.md`

## Code Reference

### Key Files

- **Webhook Handler**: `billing/src/routes/webhooks.ts`
- **Stripe Service**: `billing/src/services/stripe-service.ts` (handleSubscriptionDeleted)
- **Deployment Worker**: `billing/src/workers/deployment-worker.ts`
- **K8s Service**: `billing/src/services/k8s-deployment-service.ts` (deleteCustomerInstance)
- **Deactivation Service**: `billing/src/services/customer-deactivation.ts`
- **Subscription Model**: `billing/src/db/subscription-model.ts`
- **Customer Model**: `billing/src/db/customer-model.ts`

### Database Tables

- `subscriptions`: Subscription status and history
- `customers`: Customer status (`is_active`, `deleted_at`)
- `cleanup_queue`: Scheduled cleanup jobs
- `audit_log`: Cancellation event history
- `license_history`: License revocation records

## Summary

The subscription cancellation system provides:

✅ **Automatic cleanup** triggered by Stripe webhooks  
✅ **K8s resource deletion** via deployment worker  
✅ **Customer deactivation** with status tracking  
✅ **Optional data retention** with scheduled deletion  
✅ **Graceful cancellation** (cancel at period end)  
✅ **Monitoring & observability** via Bull Board  
✅ **Error handling** with retry logic  

No manual intervention required - the system handles all cleanup automatically when a subscription is canceled.
