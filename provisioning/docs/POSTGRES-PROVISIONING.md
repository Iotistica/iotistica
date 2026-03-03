# Self-Hosted PostgreSQL Provisioning

This guide explains how to configure the provisioning service to create per-client databases on a PostgreSQL server you already operate, instead of using the managed TigerData/Timescale Cloud API.

---

## When to Use This

Set `DB_PROVIDER=postgres` when you want to:

- Host databases on your own PostgreSQL server (on-premise or cloud VM)
- Avoid the Timescale Cloud (TigerData) API dependency
- Keep all data within your own infrastructure

The default value is `DB_PROVIDER=tigerdata` (managed Timescale Cloud). Switch to `postgres` only if you have a PostgreSQL server ready to accept admin connections.

> **Important:** `DB_PROVIDER` should be chosen before any customers are provisioned. Changing providers mid-operation does not migrate existing databases; new customers will be provisioned on the new provider while existing ones remain on the old provider.

---

## Required Environment Variables

Add the following to your `.env` (copy from `.env.example`):

```bash
# Switch from TigerData to self-hosted PostgreSQL
DB_PROVIDER=postgres

# Admin connection details – must have CREATE DATABASE and CREATE ROLE privileges
PROVISIONING_PG_HOST=localhost
PROVISIONING_PG_PORT=5432
PROVISIONING_PG_ADMIN_USER=postgres
PROVISIONING_PG_ADMIN_PASSWORD=your_admin_password_here
PROVISIONING_PG_ADMIN_DB=postgres

# SSL (set true in production)
PROVISIONING_PG_SSL=false
# Set false only for self-signed certificates in development
PROVISIONING_PG_SSL_REJECT_UNAUTHORIZED=true

# Dry-run mode – no real operations (useful for local testing)
SIMULATE_POSTGRES_PROVISIONING=false
```

All `PROVISIONING_PG_*` variables are only read when `DB_PROVIDER=postgres`. They are ignored when `DB_PROVIDER=tigerdata`.

---

## Setting Up the Admin User

The admin credentials (`PROVISIONING_PG_ADMIN_USER` / `PROVISIONING_PG_ADMIN_PASSWORD`) must belong to a PostgreSQL role that has the `CREATEDB` and `CREATEROLE` privileges.

### Option A: Use the Built-In `postgres` Superuser

The simplest approach for a dedicated provisioning server is to use the built-in `postgres` superuser.

```bash
# Connect to your server
psql -h <host> -U postgres

# Verify the user can create databases and roles
\du postgres
```

Set in `.env`:

```bash
PROVISIONING_PG_ADMIN_USER=postgres
PROVISIONING_PG_ADMIN_PASSWORD=<your postgres superuser password>
```

### Option B: Create a Dedicated Provisioning User (Recommended for Production)

```sql
-- Connect as superuser
CREATE ROLE provisioning_admin
  WITH LOGIN
       PASSWORD 'a-strong-random-password'
       CREATEDB
       CREATEROLE;
```

Set in `.env`:

```bash
PROVISIONING_PG_ADMIN_USER=provisioning_admin
PROVISIONING_PG_ADMIN_PASSWORD=a-strong-random-password
```

> **Tip:** Generate a strong password with:
> ```bash
> openssl rand -base64 32
> ```

---

## How It Works

When a customer signs up and a deployment job runs, the provisioning service:

1. Connects to your PostgreSQL server using the admin credentials.
2. Creates a new role named `client-{id}` with a randomly generated 32-character password.
3. Creates a new database named `client-{id}` owned by that role.
4. Grants all privileges on the database to the role.
5. Returns the connection details (host, port, db name, username, password) so they can be injected into the customer's deployment.

Each provisioned database is isolated: the `client-{id}` role can only access its own database.

---

## Template Database (Fast Client Provisioning)

### Where the template is stored

The template database lives on the **same PostgreSQL server** that you point to with `PROVISIONING_PG_HOST` / `PROVISIONING_PG_PORT`. It is a regular PostgreSQL database on that server – the only difference is that PostgreSQL marks it with `IS_TEMPLATE = true` and `ALLOW_CONNECTIONS = false` so it cannot be modified accidentally.

Running 90+ migration scripts on every new client database at API startup is slow. PostgreSQL's native `CREATE DATABASE … TEMPLATE` mechanism clones an entire database (all tables, indexes, functions, and extensions) at the filesystem level, making provisioning nearly instantaneous regardless of how many schema objects exist.

### Set the environment variable

```bash
# .env  (same server as PROVISIONING_PG_HOST)
PROVISIONING_PG_TEMPLATE_DB=template_iotistica
```

Leave this variable unset to fall back to the standard PostgreSQL default (an empty database).

### Create the template once

Run this once after the provisioning server is set up and whenever you want to rebuild the template from scratch:

```typescript
import { PostgresProvisioningService } from './src/services/postgres-provisioning-service';
import * as fs from 'fs';

const svc = new PostgresProvisioningService();

// Option A: create an empty template (migrations run at API startup as usual)
await svc.provisionTemplateDatabase();

// Option B: create a fully schema'd template (fastest client provisioning)
const schemaSql = fs.readFileSync('./migrations/schema.sql', 'utf8');
await svc.provisionTemplateDatabase(schemaSql);
```

The method is idempotent – if `template_iotistica` already exists on the server it is reused rather than recreated.

### Keep the template up to date after a migration

When a new migration is released, apply it to the template so future clients start with the latest schema:

```typescript
const migrationSql = fs.readFileSync('./migrations/0042_add_alerts_table.sql', 'utf8');
await svc.updateTemplateDatabase(migrationSql);
```

`updateTemplateDatabase` temporarily re-enables connections, runs the SQL, then re-locks the database.

### Full operator workflow

```
1. First deploy
   provisionTemplateDatabase(fullSchemaSql)   # creates template_iotistica once

2. New customer signs up
   provisionDatabase('client-abc123')         # clones template_iotistica instantly

3. New schema migration released
   updateTemplateDatabase(migrationSql)       # keep template in sync
   # (existing client databases run the migration normally at their next API startup)

4. Full template reset (rare)
   dropTemplateDatabase()                     # removes template_iotistica
   provisionTemplateDatabase(fullSchemaSql)   # rebuilds from scratch
```

> **Note:** `deleteDatabase()` refuses to delete the template database by name to prevent accidental data loss. Use `dropTemplateDatabase()` if you intentionally want to remove it.

---

## Local Development with Docker Compose

The `docker-compose.yml` in this directory starts a local PostgreSQL container on port `5433` (to avoid conflicts with any existing PostgreSQL on port `5432`). You can point the provisioning service at this container for local testing.

Add the following to your `.env`:

```bash
DB_PROVIDER=postgres
PROVISIONING_PG_HOST=localhost
PROVISIONING_PG_PORT=5433
PROVISIONING_PG_ADMIN_USER=billing
# The local docker-compose postgres container uses 'billing123' for development only.
# Use a strong password for any non-throwaway environment.
PROVISIONING_PG_ADMIN_PASSWORD=billing123
PROVISIONING_PG_ADMIN_DB=postgres
PROVISIONING_PG_SSL=false
```

Then start the stack:

```bash
docker-compose up -d
```

### Verify the Admin Connection

```bash
# From host (port 5433 is exposed)
psql -h localhost -p 5433 -U billing -d postgres -c "SELECT current_user;"

# Or exec into the container
docker exec -it $(docker-compose ps -q postgres) psql -U billing -d postgres
```

### Verify Provisioned Databases

After a customer signs up and a deployment job completes, confirm the database was created:

```bash
psql -h localhost -p 5433 -U billing -d postgres -c "\l" | grep client-
```

---

## Dry-Run / Simulation Mode

Set `SIMULATE_POSTGRES_PROVISIONING=true` to run without performing any real database operations. The service logs what it would do and returns mock connection details. Useful during CI or when validating the rest of the deployment pipeline.

```bash
SIMULATE_POSTGRES_PROVISIONING=true
```

---

## SSL Configuration

For production PostgreSQL servers that require TLS:

```bash
PROVISIONING_PG_SSL=true
# Verify server certificate (leave true in production)
PROVISIONING_PG_SSL_REJECT_UNAUTHORIZED=true
```

If your server uses a self-signed certificate (development only):

```bash
PROVISIONING_PG_SSL=true
PROVISIONING_PG_SSL_REJECT_UNAUTHORIZED=false
```

---

## Switching Between Providers

| `DB_PROVIDER` | Provider used | Variables required |
|---|---|---|
| `tigerdata` (default) | Timescale Cloud API | `TIGERDATA_*` |
| `postgres` | Self-hosted PostgreSQL | `PROVISIONING_PG_*` |

The switch is read at startup. Restart the provisioning service and worker after changing `DB_PROVIDER`.

> **Note:** Switching providers does not migrate existing customer databases. Customers provisioned before the switch remain on the original provider; only new customers will be provisioned on the new one. Set `DB_PROVIDER` before any customers are provisioned to avoid a mixed state.

---

## Troubleshooting

### `PROVISIONING_PG_ADMIN_PASSWORD is required`

The service failed to start because `PROVISIONING_PG_ADMIN_PASSWORD` is empty. Set it in `.env` or use `SIMULATE_POSTGRES_PROVISIONING=true` to skip real operations.

### `permission denied to create database`

The admin user does not have `CREATEDB`. Grant it:

```sql
ALTER ROLE provisioning_admin CREATEDB;
```

### `permission denied to create role`

The admin user does not have `CREATEROLE`. Grant it:

```sql
ALTER ROLE provisioning_admin CREATEROLE;
```

### `connection refused` / `could not connect to server`

- Confirm `PROVISIONING_PG_HOST` and `PROVISIONING_PG_PORT` are correct.
- Ensure the PostgreSQL server is running and accepts connections from the provisioning service host.
- Check `pg_hba.conf` to confirm the admin user is allowed to connect.

### Database Already Exists (Idempotency)

If you re-run provisioning for the same client namespace, the service detects the existing database and returns its details without re-creating it. Note that the original password is not stored and cannot be recovered this way; if you need the password again, check the customer record in the provisioning database or 1Password (if configured).
