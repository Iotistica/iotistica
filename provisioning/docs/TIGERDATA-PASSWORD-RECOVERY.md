# TigerData Password Recovery Guide

## Overview

When TigerData database passwords are missing or stored as `PENDING` in 1Password, use this recovery system to attempt automatic password reset/retrieval.

## Problem Scenarios

### 1. **PENDING Password in 1Password**
- Database created but password not saved
- 1Password secret contains `PENDING` placeholder
- Occurs when TigerData API doesn't return password for existing databases

### 2. **Timeout Retry Scenario**
- Job fails after creating database but before it becomes ready
- Password was saved to `customer.db_api_response` field
- Job retry succeeds using password from database record

### 3. **Lost Password**
- Password not in database record or 1Password
- Requires manual recovery or database recreation

## Automatic Recovery Endpoint

### POST /api/customers/:id/recover-database-password

Attempts automatic password recovery using multiple strategies:

**Recovery Strategy (in order):**
1. **API Reset** - Attempts to reset password via TigerData API
2. **API Retrieve** - Attempts to retrieve password from TigerData API
3. **Manual Instructions** - Provides detailed manual recovery steps

### Usage

```bash
# Attempt password recovery for customer
curl -X POST http://localhost:3100/api/customers/cust_abc123/recover-database-password

# Response (successful reset):
{
  "success": true,
  "message": "Database password recovered and updated in 1Password",
  "customerId": "cust_abc123",
  "serviceId": "ts_xyz789",
  "secretId": "op_secret_456",
  "recoveryMethod": "api_reset",
  "password": "[redacted]",
  "note": "Password has been updated in 1Password. Use the secret ID to retrieve it securely."
}

# Response (recovery not supported):
{
  "success": false,
  "error": "Automatic password recovery not supported",
  "message": "TigerData API does not support password reset or retrieval after database creation",
  "customerId": "cust_abc123",
  "serviceId": "ts_xyz789",
  "manualRecovery": {
    "steps": [
      "1. Log in to TigerData console: https://console.cloud.timescale.com",
      "2. Navigate to your project and find the database service",
      "3. Look for password reset or credentials option",
      "4. Copy the password and update it in 1Password manually",
      "5. Update the secret: op_secret_456"
    ],
    "alternativeApproach": [
      "If password cannot be recovered:",
      "1. Delete the existing database via TigerData console",
      "2. Use POST /api/customers/:id/retry-deployment to provision a new database",
      "3. The new database will have a fresh password saved automatically"
    ]
  },
  "databaseInfo": {
    "serviceId": "ts_xyz789",
    "host": "abc123.tsdb.cloud.timescale.com",
    "port": 5432,
    "username": "tsdbadmin",
    "dbName": "tsdb"
  }
}
```

### Response Fields

**Success Response:**
- `success: true` - Recovery succeeded
- `recoveryMethod` - How password was recovered (`api_reset`, `api_retrieve`)
- `secretId` - 1Password secret ID (if updated)
- `password` - Redacted by default, set `SHOW_PASSWORDS_IN_API=true` to expose

**Failure Response:**
- `success: false` - Automatic recovery failed
- `manualRecovery.steps` - Step-by-step manual recovery instructions
- `databaseInfo` - Database connection details for manual lookup

## Multi-Tier Password Recovery System

The deployment system has multiple fallback mechanisms to prevent password loss:

### Deployment Flow

```
1. provisionDatabase()
   ├─> New database: password from API response ✅
   └─> Existing database: password empty ⚠️

2. Check customer.db_api_response (JSON field)
   ├─> Parse: initial_password or password field
   └─> Available if job timed out after DB creation ✅

3. Check existing 1Password secret
   ├─> Retrieve password field
   └─> Available if previous deployment succeeded ✅

4. Manual recovery endpoint (THIS GUIDE)
   ├─> Attempt API reset
   ├─> Attempt API retrieve
   └─> Provide manual instructions
```

## Environment Variables

### `SHOW_PASSWORDS_IN_API`
- **Default**: `false` (passwords redacted as `[redacted]`)
- **Development**: `true` (passwords visible in API responses)
- **Production**: `false` (security best practice)

```bash
# .env
SHOW_PASSWORDS_IN_API=false  # Redact passwords in API responses
```

## TigerData API Methods

The following methods are available in `TigerDataService`:

### `resetPassword(serviceId: string): Promise<string>`
Attempts to reset the database password via TigerData API.

**Tried Endpoints:**
- `/projects/{projectId}/services/{serviceId}/reset-password`
- `/projects/{projectId}/services/{serviceId}/credentials/reset`
- `/projects/{projectId}/services/{serviceId}/password/reset`

**Returns:** New password if successful

### `getCredentials(serviceId: string): Promise<{...}>`
Attempts to retrieve database credentials including password.

**Tried Endpoints:**
- `/projects/{projectId}/services/{serviceId}/credentials`
- `/projects/{projectId}/services/{serviceId}/connection`
- `/projects/{projectId}/services/{serviceId}`

**Returns:** Credentials object with password if available

## Manual Recovery Steps

### Option 1: TigerData Console
1. Log in to [https://console.cloud.timescale.com](https://console.cloud.timescale.com)
2. Navigate to your project → Services
3. Find database by service ID (from error response)
4. Look for "Reset Password" or "Credentials" option
5. Copy new password
6. Manual update in 1Password:
   ```bash
   op item edit <secret_id> password=<new_password>
   ```

### Option 2: Delete and Recreate
1. Delete database via TigerData console:
   ```bash
   # Or via API
   curl -X DELETE http://localhost:3100/api/customers/:id/deployment
   ```

2. Retry deployment (will create fresh database with password):
   ```bash
   curl -X POST http://localhost:3100/api/customers/:id/retry-deployment
   ```

3. New database provisioned with fresh password automatically saved

## Simulation Mode

For local testing without TigerData API:

```bash
# .env
SIMULATE_TIGERDATA=true
```

**Behavior:**
- `resetPassword()` returns `simulated_reset_password_12345`
- `getCredentials()` returns mock credentials with password
- No actual API calls made

## Troubleshooting

### "No TigerData database provisioned"
**Problem:** Customer has no `db_service_id`
**Solution:** Deploy customer first via `/api/customers/:id/deploy`

### "Password recovered but failed to update 1Password"
**Problem:** Password retrieved but 1Password update failed
**Action:** Password returned in response, save manually

### "No 1Password secret exists"
**Problem:** Customer has no `secret_item_id`
**Action:** Password returned in response, create secret or save manually

### "Automatic password recovery not supported"
**Problem:** TigerData API doesn't expose passwords after creation
**Solution:** Follow manual recovery steps in response

## Related Files

**Service Files:**
- `src/services/tigerdata-service.ts` - TigerData API integration
- `src/services/onepassword-service.ts` - 1Password secret management
- `src/services/gitops-provisioning-service.ts` - Multi-tier password recovery

**Route Files:**
- `src/routes/customers.ts` - Password recovery endpoint

**Model Files:**
- `src/db/customer-model.ts` - Customer database schema (db_api_response field)

## API Reference

### Customer Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/customers/:id/recover-database-password` | Attempt password recovery |
| POST | `/api/customers/:id/retry-deployment` | Retry failed deployment (recreates DB) |
| DELETE | `/api/customers/:id/deployment` | Delete deployment (can recreate fresh) |
| GET | `/api/customers/:id` | Get customer details (check db_service_id) |

## Security Considerations

1. **Password Exposure**: By default, passwords are redacted in API responses
2. **Audit Logging**: All password recovery attempts logged to console
3. **API Access**: Recovery endpoint requires authentication (same as other customer routes)
4. **1Password Storage**: Passwords stored securely in 1Password vault
5. **Transport Security**: Use HTTPS in production for API calls

## Examples

### PowerShell Script

```powershell
# Attempt password recovery
$customerId = "cust_abc123"
$response = Invoke-RestMethod `
  -Uri "http://localhost:3100/api/customers/$customerId/recover-database-password" `
  -Method POST `
  -ContentType "application/json"

if ($response.success) {
  Write-Host "✅ Password recovered via: $($response.recoveryMethod)" -ForegroundColor Green
  Write-Host "   Secret ID: $($response.secretId)"
} else {
  Write-Host "❌ Automatic recovery failed" -ForegroundColor Red
  Write-Host "Manual recovery steps:"
  $response.manualRecovery.steps | ForEach-Object { Write-Host "   $_" }
}
```

### Node.js Script

```javascript
const axios = require('axios');

async function recoverPassword(customerId) {
  try {
    const response = await axios.post(
      `http://localhost:3100/api/customers/${customerId}/recover-database-password`
    );
    
    if (response.data.success) {
      console.log('✅ Password recovered:', response.data.recoveryMethod);
      console.log('   Secret ID:', response.data.secretId);
    }
  } catch (error) {
    if (error.response?.status === 422) {
      console.log('❌ Automatic recovery not supported');
      console.log('Manual steps:', error.response.data.manualRecovery.steps);
    } else {
      console.error('Error:', error.message);
    }
  }
}

recoverPassword('cust_abc123');
```

---

## Summary

The TigerData password recovery system provides:

✅ **Automatic Recovery** - Attempts API-based password reset/retrieval  
✅ **Multi-Tier Fallback** - Multiple strategies to find passwords  
✅ **1Password Integration** - Automatic secret updates when successful  
✅ **Manual Guidance** - Clear instructions when automatic recovery fails  
✅ **Security** - Passwords redacted by default, secure storage in 1Password  

Most database providers **do not expose passwords after creation** for security reasons. If automatic recovery fails, follow the manual recovery steps provided in the API response.
