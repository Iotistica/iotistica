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
      // Handle pre-existing database gracefully (42P04 = duplicate_database)
      await client.query(
        `CREATE DATABASE ${quotedDb} OWNER ${quotedRole}`
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
}
