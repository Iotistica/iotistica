# Argo CD Connection Tests

Tests for verifying Argo CD API connectivity and authentication.

## Test Files

### 1. TypeScript Test (`test-argocd-connection.ts`)
Full-featured test with detailed output and error handling.

**Run:**
```bash
npx ts-node tests/test-argocd-connection.ts
```

**Test specific client:**
```bash
npx ts-node tests/test-argocd-connection.ts a9c0fb7554e2
```

### 2. PowerShell Test (`test-argocd.ps1`)
Windows-friendly PowerShell version with same functionality.

**Run:**
```powershell
.\tests\test-argocd.ps1
```

**Test specific client:**
```powershell
.\tests\test-argocd.ps1 -ClientId "a9c0fb7554e2"
```

**Verbose output:**
```powershell
.\tests\test-argocd.ps1 -Verbose
```

## What The Tests Do

1. **Connection Test** - Verifies Argo CD API is accessible
2. **Authentication Test** - Validates token is correct
3. **List Applications** - Shows all deployed applications
4. **Application Details** - Displays sync/health status
5. **Specific Client Test** - Checks individual client status (optional)

## Configuration

Tests read from `.env` file in provisioning directory:

```bash
ARGOCD_BASE_URL=https://cd.iotistica.com
ARGOCD_TOKEN=<your-argo-cd-token>
ARGOCD_STATUS_MAX_RETRIES=10
ARGOCD_STATUS_RETRY_DELAY_MS=5000
SKIP_ARGOCD_STATUS_CHECK=false
```

## Getting an Argo CD Token

**Note:** Your current token appears to be a GitHub PAT (starts with `ghp_`).  
You need an Argo CD authentication token instead.

### Method 1: Argo CD UI
1. Login to Argo CD: `https://cd.iotistica.com`
2. Go to **Settings** → **Accounts**
3. Select your account
4. Click **Generate New Token**
5. Copy token and update `.env`

### Method 2: Argo CD CLI
```bash
# Login
argocd login cd.iotistica.com

# Generate token
argocd account generate-token --account admin

# Update .env with the token
```

### Method 3: Admin Password
For initial access, you can use the admin password:

```bash
# Format: admin:<password>
# Encode to base64 and use as token
echo -n "admin:your-password" | base64
```

Then update `.env`:
```bash
ARGOCD_TOKEN=YWRtaW46eW91ci1wYXNzd29yZA==
```

## Example Output

### Successful Test
```
================================================================================
  Argo CD Connection Test
================================================================================

📋 Configuration:
   Base URL: https://cd.iotistica.com
   Token:    argocd.token.12345...
   Node ENV: development

✅ Connection successful!

📊 Argo CD Version Info:
   Version:     v3.3.1
   Build Date:  2024-01-15
   Git Commit:  abc12345

✅ Found 3 application(s)

📋 Applications List:

   1. client-a9c0fb7554e2
      Namespace:  client-0da93cdf
      Sync:       ✅ Synced
      Health:     💚 Healthy
```

### Failed Authentication
```
❌ Authentication Error: Invalid token
   Your ARGOCD_TOKEN may be expired or invalid
   Generate a new token from Argo CD UI:
   Settings → Accounts → Generate New Token
```

## Troubleshooting

### DNS Resolution Failed
```
❌ Connection Error: DNS resolution failed
   Cannot resolve hostname: https://cd.iotistica.com
```
**Fix:** Check `ARGOCD_BASE_URL` in `.env`

### Connection Refused
```
❌ Connection Error: Connection refused
```
**Fix:** Verify Argo CD is running and accessible

### Authentication Failed (401)
```
❌ Authentication Error: Invalid token
```
**Fix:** Generate new token (see "Getting an Argo CD Token" above)

### Certificate Issues
Tests automatically skip SSL certificate validation in development.  
For production, ensure valid SSL certificates.

## Current Test Results

Based on your `.env` configuration:
- ✅ Argo CD URL is accessible (`https://cd.iotistica.com`)
- ✅ Argo CD version detected: `v3.3.1`
- ❌ Token authentication failing (appears to be GitHub token, not Argo CD token)

**Next Step:** Update `ARGOCD_TOKEN` in `.env` with a valid Argo CD authentication token.
