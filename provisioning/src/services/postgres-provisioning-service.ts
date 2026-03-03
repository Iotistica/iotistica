/**
 * PostgreSQL Provisioning Service
 * Provisions client databases directly on an existing (shared) PostgreSQL server.
 *
 * Instead of calling an external API such as TigerData/Timescale Cloud, this
 * service connects to a PostgreSQL instance that you already operate and runs
 * CREATE DATABASE / CREATE ROLE statements so that each client gets an isolated
 * database following the client-xxx naming convention.
 *
 * The returned object is compatible with TigerDataDatabase so it can be used
 * as a drop-in replacement inside GitOpsProvisioningService.
 */

import * as crypto from 'crypto';
import { Client as PgClient, ClientConfig } from 'pg';
import { TigerDataDatabase } from './tigerdata-service';

export interface PostgresProvisioningConfig {
  /** Hostname of the shared PostgreSQL server */
  host: string;
  /** Port of the shared PostgreSQL server (default: 5432) */
  port: number;
  /** Admin username used to create databases and roles */
  adminUser: string;
  /** Admin password */
  adminPassword: string;
  /** Admin database to connect to for DDL commands (default: 'postgres') */
  adminDatabase: string;
  /** Enable SSL/TLS for the admin connection */
  ssl: boolean;
  /**
   * When ssl is true, whether to verify the server certificate.
   * Default true (production-safe). Set false only for self-signed certs in dev.
   */
  sslRejectUnauthorized: boolean;
  /**
   * Optional name of a pre-schema'd template database (e.g. 'template_iotistica').
   * When set, each new client database is created with
   *   CREATE DATABASE … TEMPLATE <templateDatabase>
   * which physically copies the template at the filesystem level instead of
   * replaying every migration script on first API startup.  This makes database
   * provisioning nearly instantaneous regardless of how many schema objects exist
   * in the template.
   *
   * Set via env PROVISIONING_PG_TEMPLATE_DB.  Leave unset to use the standard
   * PostgreSQL default (template1 / empty database).
   */
  templateDatabase?: string;
}

export class PostgresProvisioningError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'PostgresProvisioningError';
  }
}

export class PostgresProvisioningService {
  private config: PostgresProvisioningConfig;
  private simulateMode: boolean;

  constructor(config?: Partial<PostgresProvisioningConfig>) {
    this.simulateMode = process.env.SIMULATE_POSTGRES_PROVISIONING === 'true';

    this.config = {
      host: config?.host ?? process.env.PROVISIONING_PG_HOST ?? 'localhost',
      port: config?.port ?? parseInt(process.env.PROVISIONING_PG_PORT ?? '5432', 10),
      adminUser: config?.adminUser ?? process.env.PROVISIONING_PG_ADMIN_USER ?? 'postgres',
      adminPassword: config?.adminPassword ?? process.env.PROVISIONING_PG_ADMIN_PASSWORD ?? '',
      adminDatabase: config?.adminDatabase ?? process.env.PROVISIONING_PG_ADMIN_DB ?? 'postgres',
      ssl: config?.ssl ?? (process.env.PROVISIONING_PG_SSL === 'true'),
      sslRejectUnauthorized:
        config?.sslRejectUnauthorized ??
        (process.env.PROVISIONING_PG_SSL_REJECT_UNAUTHORIZED !== 'false'),
      templateDatabase:
        config?.templateDatabase ?? process.env.PROVISIONING_PG_TEMPLATE_DB,
    };

    if (!this.simulateMode && !this.config.adminPassword) {
      throw new PostgresProvisioningError(
        'PROVISIONING_PG_ADMIN_PASSWORD is required for PostgreSQL provisioning'
      );
    }

    if (this.simulateMode) {
      console.log(
        '[PostgresProvisioningService] SIMULATION MODE ENABLED - no real database operations'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (compatible with TigerDataService)
  // ---------------------------------------------------------------------------

  /**
   * Check whether a client database already exists on the provisioning server.
   *
   * @param namespace - The client namespace, e.g. "client-dc5fec42901a"
   */
  async findDatabaseByName(namespace: string): Promise<TigerDataDatabase | null> {
    if (this.simulateMode) {
      console.log(
        `[PostgresProvisioningService] SIMULATION MODE - skipping findDatabaseByName for ${namespace}`
      );
      return null;
    }

    const client = this.createAdminClient();
    try {
      await client.connect();
      const result = await client.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = $1',
        [namespace]
      );
      if (result.rows.length === 0) {
        return null;
      }

      console.log(`[PostgresProvisioningService] Found existing database: ${namespace}`);
      return this.buildResult(namespace, namespace, '');
    } catch (error) {
      console.error('[PostgresProvisioningService] Error checking for existing database:', error);
      return null;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /**
   * Provision a new PostgreSQL database for the given client namespace.
   *
   * Creates:
   *   - DATABASE  client-{id}
   *   - ROLE      client-{id}  (with LOGIN and the generated password)
   * Grants all privileges on the new database to the new role.
   *
   * The operation is idempotent: if the database already exists the method
   * returns the existing database details without re-creating anything.
   *
   * @param namespace - Client namespace (e.g. "client-dc5fec42901a")
   */
  async provisionDatabase(namespace: string): Promise<TigerDataDatabase> {
    console.log(
      `[PostgresProvisioningService] Provisioning database for namespace: ${namespace}`
    );

    // Idempotency check
    const existing = await this.findDatabaseByName(namespace);
    if (existing) {
      console.log(
        '[PostgresProvisioningService] Database already exists, returning existing record'
      );
      console.warn(
        '[PostgresProvisioningService] WARNING: password is not available for an already-provisioned database'
      );
      return existing;
    }

    if (this.simulateMode) {
      console.log(
        '[PostgresProvisioningService] SIMULATION MODE - returning mock database result'
      );
      const password = this.generatePassword();
      return this.buildResult(namespace, namespace, password, {
        simulated: true,
        namespace,
      });
    }

    const password = this.generatePassword();
    const client = this.createAdminClient();

    try {
      await client.connect();

      // PostgreSQL identifiers that contain hyphens must be double-quoted.
      const quotedDb = this.quoteIdentifier(namespace);
      const quotedRole = this.quoteIdentifier(namespace);

      console.log(`[PostgresProvisioningService] Creating role ${namespace}`);
      // CREATE ROLE - handle pre-existing role gracefully (42710 = duplicate_object)
      await client.query(
        `CREATE ROLE ${quotedRole} WITH LOGIN PASSWORD ${this.quoteLiteral(password)}`
      ).catch(async (err: any) => {
        if (err.code === '42710') {
          console.log(`[PostgresProvisioningService] Role ${namespace} already exists, skipping`);
        } else {
          throw err;
        }
      });

      console.log(`[PostgresProvisioningService] Creating database ${namespace}`);
      // CREATE DATABASE cannot be run inside a transaction block in PostgreSQL.
      // simple-pg already auto-commits DDL so this is fine.
      // When a template database is configured it is cloned at the filesystem
      // level (copying all schema objects at once) which is orders of magnitude
      // faster than replaying individual migration scripts.
      // Handle pre-existing database gracefully (42P04 = duplicate_database)
      const templateClause = this.config.templateDatabase
        ? ` TEMPLATE ${this.quoteIdentifier(this.config.templateDatabase)}`
        : '';
      await client.query(
        `CREATE DATABASE ${quotedDb}${templateClause} OWNER ${quotedRole}`
      ).catch(async (err: any) => {
        if (err.code === '42P04') {
          console.log(`[PostgresProvisioningService] Database ${namespace} already exists, skipping`);
        } else {
          throw err;
        }
      });

      console.log(`[PostgresProvisioningService] Granting privileges on ${namespace}`);
      await client.query(
        `GRANT ALL PRIVILEGES ON DATABASE ${quotedDb} TO ${quotedRole}`
      );

      console.log(`[PostgresProvisioningService] Database ${namespace} provisioned successfully`);

      return this.buildResult(namespace, namespace, password, {
        createdAt: new Date().toISOString(),
        namespace,
      });
    } catch (error) {
      throw new PostgresProvisioningError(
        `Failed to provision database ${namespace}: ${error}`,
        error
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /**
   * No-op for PostgreSQL provisioning – the database is instantly available
   * after CREATE DATABASE returns.  This method exists solely to satisfy the
   * same interface used by TigerDataService.
   */
  async waitUntilReady(_serviceId: string): Promise<void> {
    if (this.simulateMode) {
      console.log('[PostgresProvisioningService] SIMULATION MODE - waitUntilReady is a no-op');
      return;
    }
    // PostgreSQL CREATE DATABASE is synchronous; nothing to wait for.
    console.log('[PostgresProvisioningService] Database is immediately ready (no polling needed)');
  }

  /**
   * Create (or recreate) the shared schema template database.
   *
   * Why this exists
   * ---------------
   * Running 90+ migration scripts on every new client database at API startup
   * is slow and error-prone.  PostgreSQL's native template mechanism lets you
   * clone an entire database – including every table, index, function and
   * extension – at the filesystem level via a single CREATE DATABASE statement.
   * This method builds (or refreshes) that template once; afterwards every call
   * to provisionDatabase() completes in milliseconds rather than seconds.
   *
   * Behaviour
   * ---------
   * 1. If the template database does not exist it is created from `template0`
   *    (PostgreSQL's pristine built-in template) so that it begins completely
   *    empty and independent.
   * 2. If `schemaScriptSql` is provided the SQL is executed against the
   *    template database so that every subsequently cloned client database
   *    already contains the full schema.
   * 3. After schema application the template database is marked with
   *    `IS_TEMPLATE = true` and `ALLOW_CONNECTIONS = false`.  This protects it
   *    from accidental connections while still allowing CREATE DATABASE … TEMPLATE.
   * 4. If the database already exists (idempotent re-run) the existing database
   *    is reused – use updateTemplateDatabase() to apply incremental migrations.
   *
   * @param schemaScriptSql - Optional full SQL to execute against the fresh
   *   template (e.g. the contents of your consolidated schema file).
   */
  async provisionTemplateDatabase(schemaScriptSql?: string): Promise<void> {
    const templateName = this.config.templateDatabase;
    if (!templateName) {
      throw new PostgresProvisioningError(
        'templateDatabase is not configured. Set PROVISIONING_PG_TEMPLATE_DB.'
      );
    }

    if (this.simulateMode) {
      console.log(
        `[PostgresProvisioningService] SIMULATION MODE - skipping provisionTemplateDatabase for ${templateName}`
      );
      return;
    }

    console.log(`[PostgresProvisioningService] Provisioning template database: ${templateName}`);

    const adminClient = this.createAdminClient();
    try {
      await adminClient.connect();

      // Check whether the template already exists
      const exists = await adminClient.query<{ exists: boolean }>(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [templateName]
      );

      if (exists.rows.length === 0) {
        // Create from template0 (the pristine PostgreSQL template) so the new
        // database is completely empty and not connected to template1 state.
        const quotedTemplate = this.quoteIdentifier(templateName);
        console.log(
          `[PostgresProvisioningService] Creating template database ${templateName} from template0`
        );
        await adminClient.query(
          `CREATE DATABASE ${quotedTemplate} TEMPLATE template0`
        );
      } else {
        console.log(
          `[PostgresProvisioningService] Template database ${templateName} already exists`
        );
      }
    } finally {
      await adminClient.end().catch(() => undefined);
    }

    // Apply the schema script inside the template database when provided
    if (schemaScriptSql) {
      await this.runScriptInDatabase(templateName, schemaScriptSql);
    }

    // Lock down the template: no new connections allowed, but the server can
    // still use it as a source for CREATE DATABASE … TEMPLATE.
    await this.setTemplateDatabaseFlags(templateName, true);

    console.log(
      `[PostgresProvisioningService] Template database ${templateName} is ready`
    );
  }

  /**
   * Apply an incremental schema migration to the existing template database.
   *
   * This allows keeping the template in sync with new schema versions without
   * dropping and recreating it (which would be destructive if the template were
   * still in use by an ongoing provisionDatabase() call).
   *
   * Steps:
   *  1. Temporarily re-enable connections on the template database.
   *  2. Execute `schemaScriptSql` against it.
   *  3. Re-lock it (IS_TEMPLATE=true, ALLOW_CONNECTIONS=false).
   *
   * @param schemaScriptSql - Incremental SQL to run (e.g. a single migration file).
   */
  async updateTemplateDatabase(schemaScriptSql: string): Promise<void> {
    const templateName = this.config.templateDatabase;
    if (!templateName) {
      throw new PostgresProvisioningError(
        'templateDatabase is not configured. Set PROVISIONING_PG_TEMPLATE_DB.'
      );
    }

    if (this.simulateMode) {
      console.log(
        `[PostgresProvisioningService] SIMULATION MODE - skipping updateTemplateDatabase for ${templateName}`
      );
      return;
    }

    console.log(
      `[PostgresProvisioningService] Updating template database: ${templateName}`
    );

    // Temporarily allow connections so the script client can connect
    await this.setTemplateDatabaseFlags(templateName, false);

    try {
      await this.runScriptInDatabase(templateName, schemaScriptSql);
    } finally {
      // Always re-lock, even on error
      await this.setTemplateDatabaseFlags(templateName, true).catch((err) =>
        console.error(
          '[PostgresProvisioningService] Failed to re-lock template database after update:',
          err
        )
      );
    }

    console.log(
      `[PostgresProvisioningService] Template database ${templateName} updated successfully`
    );
  }

  /**
   * Drop the template database entirely.
   *
   * This is a destructive operation intended for schema resets or re-provisioning
   * the template from scratch.  Call provisionTemplateDatabase() afterwards to
   * rebuild it.  Client databases that were already cloned from this template
   * are NOT affected – they are independent copies.
   */
  async dropTemplateDatabase(): Promise<void> {
    const templateName = this.config.templateDatabase;
    if (!templateName) {
      throw new PostgresProvisioningError(
        'templateDatabase is not configured. Set PROVISIONING_PG_TEMPLATE_DB.'
      );
    }

    if (this.simulateMode) {
      console.log(
        `[PostgresProvisioningService] SIMULATION MODE - skipping dropTemplateDatabase for ${templateName}`
      );
      return;
    }

    console.log(
      `[PostgresProvisioningService] Dropping template database: ${templateName}`
    );

    // Re-enable connections first so the DROP DATABASE command can proceed
    await this.setTemplateDatabaseFlags(templateName, false).catch(() => undefined);

    const adminClient = this.createAdminClient();
    try {
      await adminClient.connect();
      const quotedDb = this.quoteIdentifier(templateName);

      // Terminate any lingering connections before dropping
      await adminClient.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [templateName]
      ).catch(() => undefined);

      await adminClient.query(`DROP DATABASE IF EXISTS ${quotedDb}`);
      console.log(
        `[PostgresProvisioningService] Template database ${templateName} dropped`
      );
    } finally {
      await adminClient.end().catch(() => undefined);
    }
  }

  /**
   * Drop the client database and its associated role.
   *
   * @param serviceId - The database / namespace name (e.g. "client-dc5fec42901a")
   */
  async deleteDatabase(serviceId: string): Promise<void> {
    console.log(`[PostgresProvisioningService] Deleting database: ${serviceId}`);

    if (this.simulateMode) {
      console.log('[PostgresProvisioningService] SIMULATION MODE - skipping deleteDatabase');
      return;
    }

    // Refuse to delete the template database to prevent accidental data loss
    if (this.config.templateDatabase && serviceId === this.config.templateDatabase) {
      throw new PostgresProvisioningError(
        `Refusing to delete the template database '${serviceId}'. ` +
        'Call dropTemplateDatabase() if you intentionally want to remove it.'
      );
    }

    const client = this.createAdminClient();
    const errors: string[] = [];

    try {
      await client.connect();

      const quotedDb = this.quoteIdentifier(serviceId);
      const quotedRole = this.quoteIdentifier(serviceId);

      // Terminate active connections before dropping; log any failure but continue
      const termResult = await client.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [serviceId]
      ).catch((err: Error) => {
        console.warn('[PostgresProvisioningService] Could not terminate connections:', err.message);
        return null;
      });

      if (termResult) {
        const terminated = termResult.rows.filter((r: any) => r.pg_terminate_backend).length;
        if (terminated > 0) {
          console.log(`[PostgresProvisioningService] Terminated ${terminated} active connection(s) to ${serviceId}`);
        }
      }

      await client.query(`DROP DATABASE IF EXISTS ${quotedDb}`).catch((err: Error) => {
        errors.push(`DROP DATABASE failed: ${err.message}`);
        console.error('[PostgresProvisioningService] DROP DATABASE failed:', err.message);
      });

      await client.query(`DROP ROLE IF EXISTS ${quotedRole}`).catch((err: Error) => {
        errors.push(`DROP ROLE failed: ${err.message}`);
        console.error('[PostgresProvisioningService] DROP ROLE failed:', err.message);
      });

      if (errors.length > 0) {
        throw new PostgresProvisioningError(
          `Database deletion completed with errors: ${errors.join('; ')}`
        );
      }

      console.log(`[PostgresProvisioningService] Database ${serviceId} deleted successfully`);
    } catch (error) {
      if (error instanceof PostgresProvisioningError) {
        throw error;
      }
      throw new PostgresProvisioningError(
        `Failed to delete database ${serviceId}: ${error}`,
        error
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private createAdminClient(): PgClient {
    const clientConfig: ClientConfig = {
      host: this.config.host,
      port: this.config.port,
      user: this.config.adminUser,
      password: this.config.adminPassword,
      database: this.config.adminDatabase,
      ...(this.config.ssl
        ? { ssl: { rejectUnauthorized: this.config.sslRejectUnauthorized } }
        : {}),
    };
    return new PgClient(clientConfig);
  }

  /** Build a TigerDataDatabase-compatible result object */
  private buildResult(
    dbName: string,
    serviceId: string,
    password: string,
    fullResponse?: any
  ): TigerDataDatabase {
    return {
      serviceId,
      host: this.config.host,
      port: this.config.port,
      dbName,
      username: dbName, // role name matches database name
      password,
      region: 'self-hosted',
      status: 'active',
      fullResponse: fullResponse ?? null,
    };
  }

  /** Generate a cryptographically-secure 32-character alphanumeric password */
  private generatePassword(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    // Rejection-sampling avoids modulo bias: only accept byte values below the
    // largest multiple of chars.length that fits in a single byte (0-255).
    const limit = 256 - (256 % chars.length);
    let password = '';
    while (password.length < 32) {
      const bytes = crypto.randomBytes(64);
      for (const byte of bytes) {
        if (byte < limit) {
          password += chars[byte % chars.length];
          if (password.length === 32) break;
        }
      }
    }
    return password;
  }

  /**
   * Safely double-quote a PostgreSQL identifier.
   * Any embedded double-quote characters are escaped by doubling them.
   */
  private quoteIdentifier(identifier: string): string {
    return '"' + identifier.replace(/"/g, '""') + '"';
  }

  /**
   * Safely single-quote a PostgreSQL string literal.
   * Any embedded single-quote characters are escaped by doubling them.
   */
  private quoteLiteral(value: string): string {
    return "'" + value.replace(/'/g, "''") + "'";
  }

  /**
   * Set IS_TEMPLATE and ALLOW_CONNECTIONS flags on the template database.
   *
   * When `lock` is true the database is marked as a template and connections
   * are disallowed (protecting it from accidental modification).
   * When `lock` is false connections are re-enabled so a schema script can run.
   */
  private async setTemplateDatabaseFlags(dbName: string, lock: boolean): Promise<void> {
    const adminClient = this.createAdminClient();
    try {
      await adminClient.connect();
      const quotedDb = this.quoteIdentifier(dbName);
      const isTemplate = lock ? 'TRUE' : 'FALSE';
      const allowConn = lock ? 'FALSE' : 'TRUE';
      await adminClient.query(
        `ALTER DATABASE ${quotedDb} WITH IS_TEMPLATE ${isTemplate} ALLOW_CONNECTIONS ${allowConn}`
      );
      console.log(
        `[PostgresProvisioningService] Template database ${dbName}: ` +
        `is_template=${isTemplate}, allow_connections=${allowConn}`
      );
    } finally {
      await adminClient.end().catch(() => undefined);
    }
  }

  /**
   * Connect to the given database as admin and execute a raw SQL script.
   *
   * Used to apply the full schema (or an incremental migration) to the
   * template database before it is locked.
   *
   * SECURITY: The `sql` parameter is executed verbatim.  This method must only
   * ever be called with SQL that originates from trusted, operator-controlled
   * sources (e.g. a file read from the local filesystem or a checked-in
   * migration file).  Never pass user-supplied input directly.
   */
  private async runScriptInDatabase(dbName: string, sql: string): Promise<void> {
    const clientConfig = {
      host: this.config.host,
      port: this.config.port,
      user: this.config.adminUser,
      password: this.config.adminPassword,
      database: dbName,
      ...(this.config.ssl
        ? { ssl: { rejectUnauthorized: this.config.sslRejectUnauthorized } }
        : {}),
    };
    const scriptClient = new PgClient(clientConfig);
    try {
      await scriptClient.connect();
      console.log(
        `[PostgresProvisioningService] Running schema script in database: ${dbName}`
      );
      await scriptClient.query(sql);
      console.log(
        `[PostgresProvisioningService] Schema script completed in database: ${dbName}`
      );
    } catch (error) {
      throw new PostgresProvisioningError(
        `Failed to run schema script in database ${dbName}: ${error}`,
        error
      );
    } finally {
      await scriptClient.end().catch(() => undefined);
    }
  }
}
