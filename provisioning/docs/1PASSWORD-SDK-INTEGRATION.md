# 1Password SDK Integration - Complete

## Status: ✅ Integration Working (Read-Only)

The 1Password SDK has been successfully integrated into the provisioning service. The service can connect to 1Password and read items from vaults. Write permissions need to be configured in 1Password for full functionality.

## What Was Changed

### 1. Installed 1Password SDK
```bash
npm install @1password/sdk
```

### 2. Updated OnePasswordService
**File:** `provisioning/src/services/onepassword-service.ts`

- Replaced REST API calls with 1Password SDK
- Uses service account token (`ops_` prefix) for authentication
- No longer requires Connect server Docker container
- Async client initialization pattern

**Key Changes:**
- Import from `@1password/sdk` instead of axios
- `createClient()` returns `Promise<Client>` - handled with async pattern
- Use `ItemCategory.Database` enum for item categories
- Use `ItemFieldType.Text` and `ItemFieldType.Concealed` for field types
- `items.list()` returns `ItemOverview[]` (summary), `items.get()` returns full `Item`

### 3. Configuration Updates

#### `.env` File
```env
# 1Password Secrets Automation (using SDK)
ONEPASSWORD_CONNECT_TOKEN=ops_eyJzaWdnSW5BZGRy...
ONEPASSWORD_VAULT_ID=kchvvpfjvw3ewyn6yogblcibva  # Real vault ID (UUID)
```

**Note:** Vault ID must be the actual UUID, not the human-readable name. Use `tests/list-vaults.ts` to find vault IDs.

#### `.env.example` File  
Updated to remove `ONEPASSWORD_CONNECT_URL` (not needed with SDK) and add instructions for finding vault IDs.

### 4. Test Scripts Created

#### `tests/list-vaults.ts`
Lists all vaults accessible to the service account with their UUIDs.

```bash
npx ts-node tests/list-vaults.ts
```

**Output:**
```
📊 Available vaults:
   [1] IOT-CLIENTS
       ID:          kchvvpfjvw3ewyn6yogblcibva
       Description: (none)
       Type:        userCreated
```

#### `tests/test-onepassword-sdk.ts`
Comprehensive test of all CRUD operations:
- ✅ List items (working)
- ❌ Create item (requires write permission)
- ❌ Get item (requires write permission after create)
- ❌ Delete item (requires write permission)

```bash
npx ts-node tests/test-onepassword-sdk.ts
```

## Current Status

### ✅ Working Operations
- **Vault Discovery:** Can list all vaults and their IDs
- **Item Listing:** Can list all items in a vault (found 16 items)
- **Client Initialization:** Successfully connects with service account token

### ⚠️ Permissions Required
The service account currently has **read-only** access. To enable full provisioning functionality, grant these permissions in 1Password:

1. Go to https://my.1password.com
2. Navigate to Settings → Service Accounts
3. Find your service account (6kdz5bqgztpbu@1passwordserviceaccounts.ca)
4. Edit vault permissions for "IOT-CLIENTS"
5. Enable: **"Create and edit items"**

### Pending Operations (After Permission Grant)
- Create database credential items
- Update existing items
- Delete items

## API Structure

### Create Database Credentials
```typescript
const itemId = await onePasswordService.createSecretItem('client-abc123', {
  host: 'db.example.com',
  port: 5432,
  username: 'dbuser',
  password: 'securepassword',
  database: 'client_db',
});
```

Creates item with title: `sql-credentials-client-abc123`
- Category: `Database`
- Tags: `['iotistic', 'database', 'customer', 'client-abc123']`
- Fields: host, port, username, password (concealed), database

### List Items
```typescript
const items = await onePasswordService.listItems();
// Returns ItemOverview[] with id, title, category, tags
```

### Get Full Item
```typescript
const item = await onePasswordService.getItem(itemId);
// Returns complete Item with all fields and values
```

### Update Item
```typescript
await onePasswordService.updateItem(itemId, newCredentials);
```

### Delete Item
```typescript
await onePasswordService.deleteItem(itemId);
```

## Integration with Provisioning Flow

The service is already wired into the GitOps provisioning flow:

**File:** `provisioning/src/services/gitops-provisioning-service.ts`

```typescript
// 3. Create 1Password secret (40% progress)
const secretItemId = await this.onePasswordService.createSecretItem(
  clientIdentifier,
  dbCredentials
);
await this.updateProgress(clientId, 'secret_creating', 40);
```

## Next Steps

1. **Grant Write Permissions** (Required)
   - Enable "Create and edit items" for service account in IOT-CLIENTS vault

2. **Run Full Test** (After permissions)
   ```bash
   npx ts-node tests/test-onepassword-sdk.ts
   ```
   Should complete all 4 tests successfully

3. **Test Provisioning Flow**
   ```bash
   cd provisioning
   npm run migrate  # Run database migrations
   npm run dev      # Start service
   ```
   
4. **Trigger Signup**
   Follow Stripe signup flow and monitor provisioning stages:
   - `db_provisioning` → TigerData creates database
   - `secret_creating` → 1Password stores credentials ← **This step will work after permissions**
   - `git_committing` → Commits to Git repo
   - `deploying` → Argo CD deploys K8s resources

## Files Modified

1. `provisioning/src/services/onepassword-service.ts` - Complete rewrite for SDK
2. `provisioning/.env` - Removed CONNECT_URL, added real vault ID
3. `provisioning/.env.example` - Updated instructions
4. `provisioning/tests/list-vaults.ts` - New helper script
5. `provisioning/tests/test-onepassword-sdk.ts` - New test script
6. `provisioning/package.json` - Added `@1password/sdk` dependency

## Documentation Links

- [1Password SDK Docs](https://developer.1password.com/docs/sdks/node/)
- [Service Accounts](https://developer.1password.com/docs/service-accounts/)
- [SDK Type Definitions](https://github.com/1Password/onepassword-sdk-node/tree/main/src)

## Troubleshooting

### Error: "the provided ID is not in a valid format"
**Solution:** Vault ID must be the UUID, not the vault name. Run `npx ts-node tests/list-vaults.ts` to get the correct ID.

### Error: "not sufficient permissions for the item update operation"
**Solution:** Grant "Create and edit items" permission to the service account in 1Password settings.

### Error: "Failed to initialize 1Password client"
**Solution:** Verify `ONEPASSWORD_CONNECT_TOKEN` is set correctly and starts with `ops_`.

---

**Summary:** The 1Password SDK integration is complete and functional for read operations. Once write permissions are granted, the full provisioning flow will work end-to-end.
