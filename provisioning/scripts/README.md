# PostgreSQL Template Database Scripts

## Overview

These scripts help create and manage PostgreSQL template databases for fast client provisioning. Instead of running 90+ migrations on every new client database (30-60 seconds), the template is cloned at the filesystem level (~200ms).

## Prerequisites

Ensure these environment variables are set in `provisioning/.env`:

```env
PROVISIONING_PG_HOST=postgres
PROVISIONING_PG_PORT=5432
PROVISIONING_PG_ADMIN_USER=billing
PROVISIONING_PG_ADMIN_PASSWORD=billing123
PROVISIONING_PG_ADMIN_DB=postgres
PROVISIONING_PG_SSL=false
PROVISIONING_PG_SSL_REJECT_UNAUTHORIZED=false
PROVISIONING_PG_TEMPLATE_DB=template_iotistica
```

## Usage

### Create Template Database

This script reads all migrations from `api/database/migrations` and creates a template database with the full schema pre-applied.

```bash
cd provisioning
npm run create-template
```

**What it does:**
1. Reads all `.sql` files from `api/database/migrations` (sorted alphabetically)
2. Concatenates them into a single schema
3. Creates `template_iotistica` database from `template0` (pristine PostgreSQL template)
4. Executes all migrations against the template
5. Locks it with `IS_TEMPLATE=TRUE` and `ALLOW_CONNECTIONS=FALSE`

**Output:**
```
======================================
PostgreSQL Template Database Creator
======================================

📦 Template database name: template_iotistica
📁 Migrations directory: /path/to/api/database/migrations

📄 Found 2 migration file(s):
   - 001_initial_schema_snapshot.sql
   - 003_add_user_password_lifecycle_flags.sql

✅ Loaded migration: 001_initial_schema_snapshot.sql
✅ Loaded migration: 003_add_user_password_lifecycle_flags.sql

📊 Total schema size: 45231 characters

🚀 Creating template database with full schema...

✅ SUCCESS! Template database created and ready for use

📌 Next steps:
   1. Ensure PROVISIONING_PG_TEMPLATE_DB=template_iotistica is set in your .env
   2. All new client databases will be cloned from this template
   3. Provisioning time reduced from ~30-60 seconds to ~200ms per client
```

### Manual Verification

Connect to PostgreSQL and verify the template was created:

```bash
# Local development
docker exec -it iotistica-postgres psql -U billing -d postgres

# Kubernetes
kubectl exec -it -n provisioning postgres-0 -- psql -U postgres

# Check template exists
\l template_iotistica

# Verify template flags
SELECT datname, datistemplate, datallowconn 
FROM pg_database 
WHERE datname = 'template_iotistica';

-- Expected output:
--      datname        | datistemplate | datallowconn
-- --------------------+---------------+--------------
--  template_iotistica |      t        |      f
```

## How Client Provisioning Uses the Template

Once the template exists, `PostgresProvisioningService.provisionDatabase()` automatically uses it:

```sql
-- Without template (old - slow)
CREATE DATABASE "client-dc5fec42901a" OWNER "client-dc5fec42901a";
-- Then API runs 90+ migrations on first startup

-- With template (new - fast)
CREATE DATABASE "client-dc5fec42901a" TEMPLATE template_iotistica OWNER "client-dc5fec42901a";
-- Schema is already there! No migrations needed.
```

## Updating the Template (After New Migrations)

If you add new migrations to `api/database/migrations`, you have two options:

### Option 1: Recreate from Scratch (Recommended)

```bash
# Drop old template
kubectl exec -it -n provisioning postgres-0 -- psql -U postgres -c "
ALTER DATABASE template_iotistica WITH ALLOW_CONNECTIONS TRUE;
DROP DATABASE template_iotistica;
"

# Recreate with new migrations
cd provisioning
npm run create-template
```

### Option 2: Apply Incremental Migration (Advanced)

```typescript
import { PostgresProvisioningService } from './src/services/postgres-provisioning-service';
import * as fs from 'fs';

const service = new PostgresProvisioningService();
const migrationSQL = fs.readFileSync('./api/database/migrations/004_new_feature.sql', 'utf8');
await service.updateTemplateDatabase(migrationSQL);
```

## Troubleshooting

### Error: "PROVISIONING_PG_TEMPLATE_DB is required"
Set the environment variable in `.env`:
```env
PROVISIONING_PG_TEMPLATE_DB=template_iotistica
```

### Error: "Migrations directory not found"
Ensure the script can find `api/database/migrations` relative to the `scripts/` directory. The default path is `../../api/database/migrations`.

### Error: "Database already exists"
The template already exists. Drop it first:
```sql
ALTER DATABASE template_iotistica WITH ALLOW_CONNECTIONS TRUE;
DROP DATABASE template_iotistica;
```

Then re-run `npm run create-template`.

### Error: "PROVISIONING_PG_ADMIN_PASSWORD is required"
Set the admin password in `.env`:
```env
PROVISIONING_PG_ADMIN_PASSWORD=your_strong_password
```

## Performance Impact

**Before (Without Template):**
- Client provisioning: ~30-60 seconds (run all migrations)
- Cold start: Database empty, API runs migrations on boot

**After (With Template):**
- Client provisioning: ~200ms (clone template at filesystem level)
- Cold start: Database fully schema'd, API starts immediately

## Files

- `create-template.ts` - Main script for creating template database
- `README.md` - This file
- `../api/database/migrations/*.sql` - Source migration files
