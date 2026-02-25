# Stripe Dashboard Customer Creation Flow

## Overview

This document describes how to handle customers created directly in the Stripe Dashboard, automatically creating them in the Iotistic billing database and triggering K8s provisioning.

## Flow Comparison

### Current Flow (Script-Based)
1. POST `/api/customers/signup` → Creates customer in DB + Stripe
2. Customer completes Stripe checkout
3. Webhook `checkout.session.completed` → Updates subscription
4. Deployment worker provisions K8s namespace

### New Flow (Stripe Dashboard)
1. Admin creates customer + subscription in Stripe Dashboard
2. Webhook `customer.subscription.created` → **Creates customer in DB** (if not exists)
3. Webhook triggers deployment queue automatically
4. Deployment worker provisions K8s namespace

## Implementation

### 1. Enhanced Webhook Handler

The webhook handler now checks if a customer exists when receiving subscription events. If not, it creates the customer first, then proceeds with normal flow.

**Key Events:**
- `customer.created` - Log Stripe customer creation (optional)
- `customer.subscription.created` - **Create DB customer + trigger deployment**
- `customer.subscription.updated` - Update subscription status
- `checkout.session.completed` - Handle checkout (existing flow)

### 2. Customer Auto-Creation

When `customer.subscription.created` is received:

1. **Extract customer data** from Stripe customer object:
   - Email (required)
   - Name (from `name` field)
   - Company (from `metadata.company_name` if set)

2. **Check if customer exists** in billing DB by `stripe_customer_id`

3. **Create customer** if not exists:
   ```typescript
   const customer = await CustomerModel.create({
     email: stripeCustomer.email,
     companyName: stripeCustomer.metadata?.company_name || stripeCustomer.name,
     fullName: stripeCustomer.name,
     passwordHash: null  // No password for Stripe-created customers
   });
   
   await CustomerModel.update(customer.customer_id, {
     stripe_customer_id: stripeCustomer.id
   });
   ```

4. **Create subscription** in DB

5. **Trigger deployment** via deployment queue

### 3. Metadata Convention

To pass additional data when creating customers in Stripe Dashboard, use **customer metadata**:

```json
{
  "metadata": {
    "company_name": "Acme Corporation",
    "plan": "professional",
    "auto_provision": "true"
  }
}
```

### 4. Plan Detection

Determine plan from Stripe price ID:

```typescript
const priceId = subscription.items.data[0]?.price.id;
let plan: 'starter' | 'professional' | 'enterprise' = 'starter';

if (priceId === process.env.STRIPE_PRICE_STARTER) plan = 'starter';
else if (priceId === process.env.STRIPE_PRICE_PROFESSIONAL) plan = 'professional';
else if (priceId === process.env.STRIPE_PRICE_ENTERPRISE) plan = 'enterprise';
```

## Stripe Dashboard Setup

### Creating a Customer with Subscription

1. **In Stripe Dashboard** → Customers → New Customer:
   - Email: `customer@example.com`
   - Name: `John Doe`
   - Metadata:
     - `company_name`: `Acme Corp`
     - `auto_provision`: `true`

2. **Add Subscription**:
   - Click "Add subscription"
   - Select pricing plan (Starter/Professional/Enterprise)
   - Payment collection: "Charge automatically" (requires payment method) or "Send invoice"
   - Click "Start subscription"

3. **Webhook triggers**:
   - `customer.created` (logged)
   - `customer.subscription.created` (creates DB customer + deploys)

## Benefits

1. **Admin Control**: Billing admins can onboard customers without technical setup
2. **Unified Provisioning**: Same deployment flow regardless of signup method
3. **Stripe-First**: Can manage everything in Stripe Dashboard
4. **Trial Support**: Can start subscriptions with trial periods
5. **Payment Methods**: Can add payment methods before subscription creation

## Testing

### Local Testing with Stripe CLI

```bash
# Forward webhooks to local billing service
stripe listen --forward-to localhost:3100/api/webhooks/stripe

# Create test customer with subscription
stripe customers create \
  --email test@example.com \
  --name "Test User" \
  --metadata[company_name]="Test Company" \
  --metadata[auto_provision]=true

# Create subscription for customer
stripe subscriptions create \
  --customer cus_xxxxxxxxxxxxx \
  --items[0][price]=price_xxxxxxxxxxxxx \
  --payment_behavior=default_incomplete
```

### Production Webhook Configuration

Ensure webhook endpoint is configured in Stripe:
- URL: `https://billing.iotistic.ca/api/webhooks/stripe`
- Events:
  - `customer.subscription.created` ✅
  - `customer.subscription.updated` ✅
  - `customer.subscription.deleted` ✅
  - `checkout.session.completed` ✅
  - `invoice.payment_succeeded` ✅
  - `invoice.payment_failed` ✅

## Edge Cases

### 1. Customer Already Exists
- **Check**: Query by `stripe_customer_id` first
- **Action**: Skip customer creation, proceed with subscription

### 2. Missing Email
- **Check**: Stripe customer must have email
- **Action**: Log error, skip provisioning (manual intervention required)

### 3. Multiple Subscriptions
- **Check**: Customer can only have one active subscription
- **Action**: Cancel old subscription, create new one

### 4. Failed Deployment
- **Check**: Deployment worker handles failures
- **Action**: Customer status set to `failed`, deployment can be retried

## Security Considerations

1. **Webhook Signature Verification**: Always verify Stripe signatures
2. **Idempotency**: Handle duplicate webhooks gracefully
3. **No Password**: Stripe-created customers have `password_hash = null`
4. **API Access**: Customers must set password via password reset flow

## Migration Path

For existing customers created via script:
1. **No changes needed** - existing flow continues to work
2. **Both flows coexist** - webhook handles both scenarios
3. **Gradual adoption** - can transition admin-created customers to Dashboard flow

## Future Enhancements

1. **Customer Portal**: Let customers manage subscriptions via Stripe Customer Portal
2. **Usage-Based Billing**: Track device usage and bill accordingly
3. **Team Invites**: Auto-send invitation emails after provisioning
4. **Custom Onboarding**: Different provisioning based on plan tier
