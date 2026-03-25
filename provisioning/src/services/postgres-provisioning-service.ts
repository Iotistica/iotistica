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
import simpleGit, { SimpleGit } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import { TigerDataDatabase } from './tigerdata-service';

// =============================================================================
// API Migration Service
// =============================================================================

/**
 * APIMigrationService
 *
 * Fetches API database migration scripts from GitHub repository and loads them
 * for template database provisioning.
 *
 * Follows the same pattern as GitOpsProvisioningService:
 * - Uses simple-git for clone/pull operations
 * - Authenticates with GITOPS_PAT
 * - Caches repository locally to avoid repeated clones
 */
export class APIMigrationService {
  private git: SimpleGit | null = null;
  private repoDir: string;
  private repoUrl: string;
  private pat: string;
  private mainBranch: string;
  private lastMigrationCount: number = 0;

  constructor(repoUrl?: string, pat?: string, repoDir?: string) {
    // Use environment variables by default (consistent with GitOpsProvisioningService)
    // For API migrations, we need the main Iotistica repo, not the K8s deployment repo
    this.repoUrl = repoUrl || process.env.GITOPS_REPO_URL || 'https://github.com/Iotistica/iotistic.git';
    
    // If the repo is the K8s deployment repo, use the main Iotistica repo for migrations instead
    if (this.repoUrl.includes('iot-k8s')) {
      this.repoUrl = 'https://github.com/Iotistica/iotistic.git';
    }
    
    this.pat = pat || process.env.GITOPS_PAT || '';
    this.repoDir = repoDir || '/tmp/iotistic-migrations';
    this.mainBranch = process.env.GITOPS_MAIN_BRANCH || 'master';

    // Don't initialize git here - it will fail if repoDir doesn't exist yet
    // Initialize lazily when first needed

    if (!this.pat) {
      logger.warn('[APIMigrationService] GITOPS_PAT not set - cloning may fail for private repos');
    }
  }

  /**
   * Initialize git instance lazily (only when first needed)
   * This prevents errors at module load time when repoDir doesn't exist
   */
  private getGit(): SimpleGit {
    if (!this.git) {
      this.git = simpleGit({
        baseDir: this.repoDir,
        config: [
          'user.name=Iotistica Template Builder',
          'user.email=provisioning@iotistica.com',
        ],
      });
    }
    return this.git;
  }

  /**
   * Fetch latest API migrations from GitHub and return concatenated SQL
   *
   * Steps:
   * 1. Clone or pull latest from GitHub
   * 2. Read all *.sql files from api/database/migrations/
   * 3. Sort alphabetically (001_*, 002_*, etc.)
   * 4. Concatenate all SQL with line breaks
   *
   * @returns Concatenated SQL string ready to apply to template database
   */
  async fetchLatestMigrations(): Promise<string> {
    logger.info('[APIMigrationService] Fetching latest API migrations from GitHub', {
      repo: this.repoUrl,
      branch: this.mainBranch,
    });

    try {
      // Ensure parent directory exists before any git operations
      const parentDir = path.dirname(this.repoDir);
      await fs.mkdir(parentDir, { recursive: true });
      
      // Sync repository (clone or pull)
      await this.syncRepository();

      // Read migration files
      const migrationsDir = path.join(this.repoDir, 'api', 'database', 'migrations');

      logger.info('[APIMigrationService] Reading migration files', {
        directory: migrationsDir,
      });

      const files = (await fs.readdir(migrationsDir))
        .filter((f) => f.endsWith('.sql'))
        .sort(); // Alphabetical: 001_, 002_, etc.

      if (files.length === 0) {
        throw new Error(
          `No migration files (*.sql) found in ${migrationsDir}\n` +
            'Expected structure: api/database/migrations/001_*.sql, 002_*.sql, etc.'
        );
      }

      logger.info('[APIMigrationService] Found migration files', {
        count: files.length,
        files: files.map((f) => `  - ${f}`).join('\n'),
      });

      // Read and concatenate all SQL files
      const sqlParts: string[] = [];
      for (const file of files) {
        const filePath = path.join(migrationsDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        sqlParts.push(content);
        logger.debug('[APIMigrationService] Loaded migration', {
          file,
          bytes: content.length,
        });
      }

      const combinedSql = sqlParts.join('\n\n');

      logger.info('[APIMigrationService] Successfully loaded all migrations', {
        fileCount: files.length,
        totalBytes: combinedSql.length,
      });

      // Store for later retrieval
      this.lastMigrationCount = files.length;

      return combinedSql;
    } catch (error) {
      logger.error('[APIMigrationService] Failed to fetch migrations', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Clone or pull the latest changes from the GitHub repository
   *
   * - If repository doesn't exist: clone with shallow depth (--depth=1)
   * - If repository exists: pull latest changes
   *
   * Authentication via GITOPS_PAT is handled automatically using
   * GitHub's x-access-token mechanism.
   */
  private async syncRepository(): Promise<void> {
    const dirExists = await fs
      .access(this.repoDir)
      .then(() => true)
      .catch(() => false);

    if (!dirExists) {
      // Clone repository - create directory if needed
      logger.info('[APIMigrationService] Repository not found locally, cloning...', {
        directory: this.repoDir,
      });

      // Ensure parent directories exist
      await fs.mkdir(path.dirname(this.repoDir), { recursive: true });

      // Construct authenticated URL if PAT is available
      let cloneUrl = this.repoUrl;
      if (this.pat) {
        // Replace https://github.com/Iotistica/iotistic.git
        // with https://x-access-token:{PAT}@github.com/Iotistica/iotistic.git
        cloneUrl = this.repoUrl.replace(
          'https://github.com/',
          `https://x-access-token:${this.pat}@github.com/`
        );
      }

      try {
        // Use simple-git without baseDir for clone, since the directory doesn't exist yet
        // Create parent directory first to ensure it exists
        const parentDir = path.dirname(this.repoDir);
        const baseName = path.basename(this.repoDir);
        
        // Initialize git in current working directory and use clone with target directory
        const git = simpleGit();
        await git.clone(cloneUrl, this.repoDir, [
          '--depth=1',
          `--branch=${this.mainBranch}`,
        ]);
        
        // Reset the git instance so it reinitializes with the now-existent directory
        this.git = null;
        
        logger.info('[APIMigrationService] Repository cloned successfully', {
          directory: this.repoDir,
          branch: this.mainBranch,
        });
      } catch (error) {
        logger.error('[APIMigrationService] Clone failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    } else {
      // Pull latest changes
      logger.info('[APIMigrationService] Repository exists, pulling latest changes...');

      try {
        // Ensure we're on the correct branch
        const git = this.getGit();
        await git.checkout(this.mainBranch);
        await git.pull('origin', this.mainBranch);
        logger.info('[APIMigrationService] Repository updated successfully', {
          branch: this.mainBranch,
        });
      } catch (error) {
        logger.error('[APIMigrationService] Pull failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  /**
   * Get repository metadata (for diagnostics)
   *
   * @returns Object with repo path, URL, and branch info
   */
  getMetadata() {
    return {
      repoDir: this.repoDir,
      repoUrl: this.repoUrl,
      branch: this.mainBranch,
      authenticated: !!this.pat,
    };
  }

  /**
   * Get the number of migration files loaded in the last fetch
   */
  getMigrationCount(): number {
    return this.lastMigrationCount;
  }

  /**
   * Get Git version metadata (commit hash, tags) from the repository
   * 
   * @returns Version metadata object with commit hash, tag, and timestamp
   */
  async getVersionMetadata(): Promise<{
    commitHash: string;
    commitShort: string;
    tag: string | null;
    branch: string;
    timestamp: string;
  }> {
    const git = this.getGit();

    try {
      // Get current commit hash (full and short)
      const commitHash = await git.revparse(['HEAD']);
      const commitShort = commitHash.substring(0, 7);

      // Get tag if current commit is tagged
      let tag: string | null = null;
      try {
        const tagResult = await git.tag(['--points-at', 'HEAD']);
        tag = tagResult.trim() || null;
      } catch (error) {
        // No tag on current commit - that's fine
        tag = null;
      }

      // Get commit timestamp
      const timestampStr = await git.show(['-s', '--format=%cI', 'HEAD']);
      const timestamp = timestampStr.trim();

      logger.info('[APIMigrationService] Retrieved version metadata', {
        commitHash: commitShort,
        tag,
        timestamp,
      });

      return {
        commitHash,
        commitShort,
        tag,
        branch: this.mainBranch,
        timestamp,
      };
    } catch (error) {
      logger.error('[APIMigrationService] Failed to retrieve version metadata', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Clean up local repository cache (destructive - use with caution)
   */
  async cleanup(): Promise<void> {
    try {
      await fs.rm(this.repoDir, { recursive: true, force: true });
      logger.info('[APIMigrationService] Repository cache cleaned');
    } catch (error) {
      logger.error('[APIMigrationService] Failed to clean cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// =============================================================================
// PostgreSQL Provisioning Service
// =============================================================================

export interface PostgresProvisioningConfig {
  /** Hostname of the shared PostgreSQL server */
  host: string;
  /** Port of the shared PostgreSQL server (default: 5432) */
  port: number;
  /**
   * Admin username used to create databases and roles.
   * 
   * SECURITY REQUIREMENT: This user MUST have CREATEDB and CREATEROLE privileges,
   * but MUST NOT be a superuser.
   * 
   * Recommended setup for a dedicated provisioning user:
   * 
   *   -- As superuser (e.g., postgres):
   *   CREATE ROLE provisioner WITH LOGIN PASSWORD '...';
   *   ALTER ROLE provisioner CREATEDB CREATEROLE;
   *   
   *   -- Verify (should show true for both):
   *   SELECT useCreatedb, useCreateRole FROM pg_user WHERE usename = 'provisioner';
   * 
   * This ensures the provisioning service can create databases and roles
   * without full superuser privileges (principle of least privilege).
   * 
   * Set via env PROVISIONING_PG_ADMIN_USER (default: 'postgres' for backward compatibility).
   */
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
    } else {
      // Log provisioning config (sensitive values masked)
      console.log('[PostgresProvisioningService] Initialized with:', {
        host: this.config.host,
        port: this.config.port,
        adminUser: this.config.adminUser,
        adminDatabase: this.config.adminDatabase,
        ssl: this.config.ssl,
        templateDatabase: this.config.templateDatabase || '(not configured)',
      });
      console.log(
        '[PostgresProvisioningService] SECURITY: Provisioning user must have CREATEDB + CREATEROLE (not superuser).\n' +
        '[PostgresProvisioningService] Setup: ALTER ROLE ' + this.config.adminUser + ' CREATEDB CREATEROLE;'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (compatible with TigerDataService)
  // ---------------------------------------------------------------------------

  /**
   * Get the configured template database name
   * @returns The template database name or null if not configured
   */
  getTemplateDatabaseName(): string {
    return this.config.templateDatabase || '';
  }

  /**
   * Get detailed status of the template database
   * 
   * @returns Template metadata including existence, properties, table count, and version info
   */
  async getTemplateStatus(): Promise<{
    exists: boolean;
    datname?: string;
    datistemplate?: boolean;
    datallowconn?: boolean;
    tableCount?: number;
    version?: {
      commitHash?: string;
      commitShort?: string;
      tag?: string | null;
      branch?: string;
      appliedAt?: string;
      source?: string;
      migrationCount?: number;
    };
    error?: string;
  }> {
    const templateName = this.config.templateDatabase;
    if (!templateName) {
      return {
        exists: false,
        error: 'Template database not configured. Set PROVISIONING_PG_TEMPLATE_DB.',
      };
    }

    if (this.simulateMode) {
      return {
        exists: true,
        datname: templateName,
        datistemplate: true,
        datallowconn: false,
        tableCount: 0,
      };
    }

    const adminClient = this.createAdminClient();
    try {
      await adminClient.connect();

      // Get template database metadata
      const templateQuery = await adminClient.query(
        `SELECT datname, datistemplate, datallowconn 
           FROM pg_database 
          WHERE datname = $1`,
        [templateName]
      );

      if (templateQuery.rows.length === 0) {
        return { exists: false };
      }

      const template = templateQuery.rows[0];

      // Count tables in template
      const tableQuery = await adminClient.query(
        `SELECT COUNT(*) as count
           FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            AND table_catalog = $1`,
        [templateName]
      );

      const tableCount = parseInt(tableQuery.rows[0].count, 10);

      // Fetch version metadata from system_config table
      let versionInfo: any = undefined;
      try {
        const versionQuery = await adminClient.query(
          `SELECT value FROM system_config WHERE key = $1`,
          ['schema.version']
        );
        if (versionQuery.rows.length > 0) {
          versionInfo = versionQuery.rows[0].value;
        }
      } catch (error) {
        logger.debug('[PostgresProvisioningService] No version metadata found in template');
      }

      return {
        exists: true,
        datname: template.datname,
        datistemplate: template.datistemplate,
        datallowconn: template.datallowconn,
        tableCount,
        version: versionInfo,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        exists: false,
        error: `Failed to query template status: ${errorMsg}`,
      };
    } finally {
      await adminClient.end().catch(() => undefined);
    }
  }

  /**
   * Validate that the provisioning admin user has required privileges.
   * 
   * SECURITY CHECK: Verifies the admin user has:
   * - CREATEDB privilege (to create client databases)
   * - CREATEROLE privilege (to create client roles)
   * - NOT superuser privileges (principle of least privilege)
   * 
   * @returns { valid: boolean, usecreatedb: boolean, usecreaterole: boolean, usesuper: boolean, warnings: string[] }
   */
  async validateProvisioningUserPermissions(): Promise<{
    valid: boolean;
    usecreatedb: boolean;
    usecreaterole: boolean;
    usesuper: boolean;
    warnings: string[];
  }> {
    const adminClient = this.createAdminClient();
    const warnings: string[] = [];
    
    try {
      await adminClient.connect();
      
      const result = await adminClient.query(
        `SELECT usecreatedb, usecreaterole, usesuper 
         FROM pg_user WHERE usename = $1`,
        [this.config.adminUser]
      );
      
      if (result.rows.length === 0) {
        return {
          valid: false,
          usecreatedb: false,
          usecreaterole: false,
          usesuper: false,
          warnings: [`User '${this.config.adminUser}' not found in pg_user`],
        };
      }
      
      const user = result.rows[0];
      const valid = user.usecreatedb && user.usecreaterole && !user.usesuper;
      
      if (!user.usecreatedb) {
        warnings.push(`User '${this.config.adminUser}' lacks CREATEDB privilege`);
      }
      if (!user.usecreaterole) {
        warnings.push(`User '${this.config.adminUser}' lacks CREATEROLE privilege`);
      }
      if (user.usesuper) {
        warnings.push(`User '${this.config.adminUser}' has superuser privilege (not recommended)`);
      }
      
      return {
        valid,
        usecreatedb: user.usecreatedb,
        usecreaterole: user.usecreaterole,
        usesuper: user.usesuper,
        warnings,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        usecreatedb: false,
        usecreaterole: false,
        usesuper: false,
        warnings: [`Failed to validate user permissions: ${msg}`],
      };
    } finally {
      await adminClient.end().catch(() => undefined);
    }
  }

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

      // Acquire advisory lock to prevent parallel provisioning of same tenant
      // Uses hashtext(namespace) to create a consistent lock ID from the namespace name
      console.log(`[PostgresProvisioningService] Acquiring advisory lock for ${namespace}`);
      await client.query(
        `SELECT pg_advisory_lock(hashtext($1))`,
        [namespace]
      );
      console.log(`[PostgresProvisioningService] Lock acquired for ${namespace}`);

      // PostgreSQL identifiers that contain hyphens must be double-quoted.
      const quotedDb = this.quoteIdentifier(namespace);
      const quotedOwnerRole = this.quoteIdentifier(`${namespace}-owner`);
      const quotedAppRole = this.quoteIdentifier(`${namespace}-app`);

      console.log(`[PostgresProvisioningService] Creating roles for ${namespace}`);
      
      // Create owner role (no login, used for database ownership only)
      await client.query(
        `CREATE ROLE ${quotedOwnerRole}`
      ).catch(async (err: any) => {
        if (err.code === '42710') {
          console.log(`[PostgresProvisioningService] Owner role ${namespace}-owner already exists, skipping`);
        } else {
          throw err;
        }
      });
      
      // Create app role (with login, used by application)
      await client.query(
        `CREATE ROLE ${quotedAppRole} WITH LOGIN PASSWORD ${this.quoteLiteral(password)}`
      ).catch(async (err: any) => {
        if (err.code === '42710') {
          console.log(`[PostgresProvisioningService] App role ${namespace}-app already exists, skipping`);
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
      
      // Start timing for database creation
      const dbCreationStart = Date.now();
      
      // Before creating from template, terminate any connections to the template database
      // (e.g., from pgAdmin or other tools) to allow cloning
      if (this.config.templateDatabase) {
        console.log(`[PostgresProvisioningService] Terminating connections to template ${this.config.templateDatabase}...`);
        
        // Terminate active connections with retries to ensure they're all closed
        let terminateAttempts = 0;
        const maxTerminateAttempts = 3;
        
        while (terminateAttempts < maxTerminateAttempts) {
          try {
            // Terminate all connections to the template except ours
            const result = await client.query(
              `SELECT pg_terminate_backend(pid)
                 FROM pg_stat_activity
                WHERE datname = $1 AND pid <> pg_backend_pid()`,
              [this.config.templateDatabase]
            );
            
            const terminatedCount = result.rows.filter((r: any) => r.pg_terminate_backend).length;
            console.log(`[PostgresProvisioningService] Terminated ${terminatedCount} connection(s) to template`);
            
            // Check if there are still any active connections
            const activeResult = await client.query(
              `SELECT count(*) as count FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
              [this.config.templateDatabase]
            );
            
            const activeCount = parseInt(activeResult.rows[0].count, 10);
            if (activeCount === 0) {
              console.log('[PostgresProvisioningService] All connections to template terminated successfully');
              break;
            }
            
            console.log(`[PostgresProvisioningService] Still ${activeCount} active connection(s), waiting...`);
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 500));
            terminateAttempts++;
          } catch (err: any) {
            console.warn(`[PostgresProvisioningService] Error terminating connections (attempt ${terminateAttempts + 1}):`, err.message);
            terminateAttempts++;
          }
        }
      }
      
      // Handle pre-existing database gracefully (42P04 = duplicate_database)
      const templateClause = this.config.templateDatabase
        ? ` TEMPLATE ${this.quoteIdentifier(this.config.templateDatabase)}`
        : '';
      
      const createDbStart = Date.now();
      try {
        await client.query(
          `CREATE DATABASE ${quotedDb}${templateClause} OWNER ${quotedOwnerRole}`
        );
      } catch (err: any) {
        if (err.code === '42P04') {
          console.log(`[PostgresProvisioningService] Database ${namespace} already exists, skipping`);
        } else if (err.code === '55006' && this.config.templateDatabase) {
          console.warn(
            `[PostgresProvisioningService] Template ${this.config.templateDatabase} is busy (55006), retrying once after terminating active sessions`
          );

          await client.query(
            `SELECT pg_terminate_backend(pid)
               FROM pg_stat_activity
              WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [this.config.templateDatabase]
          ).catch((terminateErr: any) => {
            console.warn(
              `[PostgresProvisioningService] Could not terminate template sessions during retry: ${terminateErr.message}`
            );
          });

          await new Promise(resolve => setTimeout(resolve, 500));

          await client.query(
            `CREATE DATABASE ${quotedDb}${templateClause} OWNER ${quotedOwnerRole}`
          );
          console.log('[PostgresProvisioningService] CREATE DATABASE retry succeeded after template session cleanup');
        } else {
          throw err;
        }
      }
      const createDbDuration = Date.now() - createDbStart;
      console.log(`[PostgresProvisioningService] ⏱️  CREATE DATABASE completed in ${createDbDuration}ms`);

      console.log(`[PostgresProvisioningService] Granting privileges on ${namespace}`);
      // Grant app role permission to connect to the database
      await client.query(
        `GRANT CONNECT ON DATABASE ${quotedDb} TO ${quotedAppRole}`
      );
      
      // Grant owner role all privileges (for schema management and migrations)
      await client.query(
        `GRANT ALL PRIVILEGES ON DATABASE ${quotedDb} TO ${quotedOwnerRole}`
      );

      const totalDuration = Date.now() - dbCreationStart;
      console.log(`[PostgresProvisioningService] ✅ Database ${namespace} provisioned successfully`);
      console.log(`[PostgresProvisioningService] ⏱️  Total provisioning time: ${totalDuration}ms (CREATE DATABASE: ${createDbDuration}ms)`);

      // Grant app role schema privileges (only to public schema, most restrictive)
      console.log(`[PostgresProvisioningService] Granting schema privileges to app role`);
      const schemaClient = new PgClient({
        host: this.config.host,
        port: this.config.port,
        user: this.config.adminUser,
        password: this.config.adminPassword,
        database: namespace,
        ssl: this.config.ssl
          ? { rejectUnauthorized: this.config.sslRejectUnauthorized }
          : false,
      });
      
      try {
        await schemaClient.connect();

        // Validate platform-managed extensions are present in cloned customer DB.
        // App-role migrations intentionally do not manage extension lifecycle.
        const extensionCheck = await schemaClient.query(
          `SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])`,
          [['timescaledb', 'pgcrypto']]
        );
        const installedExtensions = new Set(extensionCheck.rows.map((r: any) => r.extname));
        const missingExtensions = ['timescaledb', 'pgcrypto'].filter(ext => !installedExtensions.has(ext));
        if (missingExtensions.length > 0) {
          throw new Error(
            `Missing required extensions in customer database ${namespace}: ${missingExtensions.join(', ')}. ` +
            `Ensure template database ${this.config.templateDatabase || '<none>'} has required extensions installed.`
          );
        }

        // Grant app role USAGE and CREATE on public schema
        await schemaClient.query(
          `GRANT USAGE ON SCHEMA public TO ${quotedAppRole}`
        );
        await schemaClient.query(
          `GRANT CREATE ON SCHEMA public TO ${quotedAppRole}`
        );
        // Set default privileges for all new objects created by owner
        // So app role can access them
        await schemaClient.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${quotedAppRole}`
        );
        await schemaClient.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ${quotedAppRole}`
        );
        await schemaClient.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${quotedAppRole}`
        );
        
        // CRITICAL: Grant permissions on EXISTING tables/sequences/functions
        // (these were copied from the template database and aren't covered by DEFAULT PRIVILEGES)
        console.log(`[PostgresProvisioningService] Granting permissions on existing tables from template`);
        await schemaClient.query(
          `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${quotedAppRole}`
        );
        await schemaClient.query(
          `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quotedAppRole}`
        );
        await schemaClient.query(
          `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${quotedAppRole}`
        );
        
        console.log(`[PostgresProvisioningService] Schema privileges granted to app role`);
      } finally {
        await schemaClient.end().catch(() => undefined);
      }

      // Log schema version inherited from template (if available)
      if (this.config.templateDatabase) {
        const versionClient = new PgClient({
          host: this.config.host,
          port: this.config.port,
          user: this.config.adminUser,
          password: this.config.adminPassword,
          database: namespace,
          ssl: this.config.ssl
            ? { rejectUnauthorized: this.config.sslRejectUnauthorized }
            : false,
        });
        
        try {
          await versionClient.connect();
          const versionQuery = await versionClient.query(
            `SELECT value FROM system_config WHERE key = $1`,
            ['schema.version']
          );
          if (versionQuery.rows.length > 0) {
            const version = versionQuery.rows[0].value;
            console.log(`[PostgresProvisioningService] 📦 Schema version: ${version.commitShort || 'unknown'} (tag: ${version.tag || 'none'})`);
          }
        } catch (err) {
          // Version info not critical, just log at debug level
          logger.debug('[PostgresProvisioningService] Could not fetch schema version from new database');
        } finally {
          await versionClient.end().catch(() => undefined);
        }
      }

      return this.buildResult(namespace, `${namespace}-app`, password, {
        createdAt: new Date().toISOString(),
        namespace,
        ownerRole: `${namespace}-owner`,
        appRole: `${namespace}-app`,
        initial_password: password, // persisted in db_api_response for password recovery on retry
      });
    } catch (error) {
      throw new PostgresProvisioningError(
        `Failed to provision database ${namespace}: ${error}`,
        error
      );
    } finally {
      // Release advisory lock to allow other provisioning requests
      try {
        console.log(`[PostgresProvisioningService] Releasing advisory lock for ${namespace}`);
        await client.query(
          `SELECT pg_advisory_unlock(hashtext($1))`,
          [namespace]
        );
        console.log(`[PostgresProvisioningService] Lock released for ${namespace}`);
      } catch (err: any) {
        // Lock release failure should not block cleanup
        console.warn(
          `[PostgresProvisioningService] Warning: Failed to release advisory lock for ${namespace}: ${err.message}`
        );
      }
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

    const totalStart = Date.now();
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

    const totalDuration = Date.now() - totalStart;
    console.log(
      `[PostgresProvisioningService] ✅ Template database ${templateName} is ready (total time: ${totalDuration}ms)`
    );
  }

  /**
   * Insert schema version metadata into the template database's system_config table
   * 
   * Stores complete version information including:
   * - Git commit hash, tag, branch
   * - Migration count
   * - SHA256 hash of migration bundle (for drift detection)
   * - Timestamp of template initialization
   * 
   * The schemaHash field enables detection of accidental schema drift if:
   * - Migrations are modified or reordered
   * - SQL is edited inadvertently
   * - Template database is corrupted
   * 
   * Since the template is locked (datallowconn=false) after provisioning, this method:
   * 1. Temporarily re-enables connections on the template
   * 2. Inserts the version metadata
   * 3. Re-locks the template
   * 
   * @param templateName - Name of the template database
   * @param versionMetadata - Git version metadata to store
   * @param migrationCount - Number of migration files applied
   * @param schemaHash - SHA256 hash of complete migration bundle (for drift detection)
   */
  async insertVersionMetadata(
    templateName: string,
    versionMetadata: {
      commitHash: string;
      commitShort: string;
      tag: string | null;
      branch: string;
      timestamp: string;
    },
    migrationCount: number,
    schemaHash?: string
  ): Promise<void> {
    console.log('[PostgresProvisioningService] Inserting schema version metadata into template');

    // Step 1: Temporarily unlock the template so we can connect
    await this.setTemplateDatabaseFlags(templateName, false);

    const clientConfig = {
      host: this.config.host,
      port: this.config.port,
      user: this.config.adminUser,
      password: this.config.adminPassword,
      database: templateName,
      ssl: this.config.ssl
        ? { rejectUnauthorized: this.config.sslRejectUnauthorized }
        : false,
    };

    const client = new PgClient(clientConfig);

    try {
      await client.connect();

      const versionData = {
        commitHash: versionMetadata.commitHash,
        commitShort: versionMetadata.commitShort,
        tag: versionMetadata.tag,
        branch: versionMetadata.branch,
        appliedAt: new Date().toISOString(),
        source: 'github',
        migrationCount,
        repoTimestamp: versionMetadata.timestamp,
        schemaHash: schemaHash || null,
      };

      // Insert or update version metadata in system_config
      await client.query(
        `INSERT INTO system_config (key, value, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             updated_at = CURRENT_TIMESTAMP`,
        ['schema.version', JSON.stringify(versionData)]
      );

      console.log('[PostgresProvisioningService] ✅ Version metadata inserted', {
        commit: versionMetadata.commitShort,
        tag: versionMetadata.tag || 'none',
        migrations: migrationCount,
        schemaHash: schemaHash ? schemaHash.substring(0, 8) + '...' : 'none',
      });
    } catch (error) {
      logger.error('[PostgresProvisioningService] Failed to insert version metadata', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new PostgresProvisioningError(
        `Failed to insert version metadata: ${error}`,
        error
      );
    } finally {
      await client.end().catch(() => undefined);
      
      // Step 2: Re-lock the template
      await this.setTemplateDatabaseFlags(templateName, true);
    }
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

  /**
   * Create a PostgreSQL admin client connected to the provisioning server
   * @internal Exposed for internal/testing use only
   */
  createAdminClient(): PgClient {
    const clientConfig: ClientConfig = {
      host: this.config.host,
      port: this.config.port,
      user: this.config.adminUser,
      password: this.config.adminPassword,
      database: this.config.adminDatabase,
      ssl: this.config.ssl
        ? { rejectUnauthorized: this.config.sslRejectUnauthorized }
        : false,
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
      username: serviceId, // serviceId is the app role (e.g., client-xxx-app)
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

      // Hardening: when locking the template, first terminate any existing sessions.
      // ALLOW_CONNECTIONS=false only blocks NEW sessions; existing sessions can remain.
      if (lock) {
        const terminateResult = await adminClient.query(
          `SELECT pg_terminate_backend(pid)
             FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName]
        ).catch((err: any) => {
          console.warn(
            `[PostgresProvisioningService] Could not terminate existing template sessions for ${dbName}: ${err.message}`
          );
          return null;
        });

        if (terminateResult) {
          const terminated = terminateResult.rows.filter((r: any) => r.pg_terminate_backend).length;
          if (terminated > 0) {
            console.log(
              `[PostgresProvisioningService] Terminated ${terminated} existing session(s) before locking template ${dbName}`
            );
          }
        }
      }

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
      ssl: this.config.ssl
        ? { rejectUnauthorized: this.config.sslRejectUnauthorized }
        : false,
    };
    const scriptClient = new PgClient(clientConfig);
    try {
      await scriptClient.connect();
      console.log(
        `[PostgresProvisioningService] Running schema script in database: ${dbName}`
      );
      
      const scriptStart = Date.now();
      await scriptClient.query(sql);
      const scriptDuration = Date.now() - scriptStart;
      
      console.log(
        `[PostgresProvisioningService] ⏱️  Schema script completed in database: ${dbName} (${scriptDuration}ms)`
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
