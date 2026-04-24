/**
 * GitOps Provisioning Service
 * Manages client deployments via Git commits instead of direct Helm operations
 * 
 * Flow:
 * 1. Clone/pull iot-k8s-main repository
 * 2. Provision TigerData database
 * 3. Create 1Password secrets (SQL, MQTT, API-JWT, License)
 * 4. Generate Argo CD Application manifest
 * 5. Generate client-specific values file
 * 6. Commit and push to main branch
 * 7. Argo CD auto-syncs changes to Kubernetes
 * 
 * Auth: Uses Auth0 for authentication (no password bootstrap needed)
 */

import simpleGit, { SimpleGit } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import axios from 'axios';
import { Job } from 'bull';
import { logger } from '../utils/logger';
import { TigerDataService, TigerDataDatabase } from './tigerdata-service';
import { PostgresProvisioningService } from './postgres-provisioning-service';
import { OnePasswordService } from './onepassword-service';
import { CustomerModel } from '../db/customer-model';
import { SecretBuilder } from './secret-builder';
import { releaseService } from './release-service';
import { ArgoStatusService } from './argo-status-service';

interface ClientDeploymentData {
  clientId: string;           // Sanitized: dc5fec42901a (SHA256 hash)
  customerId: string;         // Internal ID: 47d48f27e0774d6a9f89a1c1dab9870a
  email: string;
  companyName: string;
  plan: 'starter' | 'professional' | 'enterprise';
  licenseKey: string;         // JWT token (customer-specific)
  namespace: string;          // client-dc5fec42901a
  domain?: string;            // iotistica.com
  
  // Monitoring configuration (from license JWT)
  monitoring?: {
    enabled: boolean;
    dedicated: boolean;
    retention: string;        // "30d"
    storageSize: string;      // "50Gi"
  };
  
  // Database credentials (generated)
  postgres?: {
    username: string;
    password: string;
    database: string;
  };
}

interface GitOpsConfig {
  enabled: boolean;
  repoUrl: string;
  repoDir: string;
  mainBranch: string;
  pat: string;
  authorName: string;
  authorEmail: string;
  argocdProject: string;
  argocdNamespace: string;
}

export class GitOpsProvisioningService {
  private git: SimpleGit;
  private config: GitOpsConfig;
  private initialized = false;
  private dbProvider: 'tigerdata' | 'postgres' | 'cnpg';
  private tigerDataService: TigerDataService;
  private postgresProvisioningService?: PostgresProvisioningService;
  private onePasswordService: OnePasswordService;
  private argoStatusService: ArgoStatusService;

  constructor() {
    // Load configuration from environment
    this.config = {
      enabled: process.env.GITOPS_ENABLED === 'true',
      repoUrl: process.env.GITOPS_REPO_URL || 'https://github.com/Iotistica/iot-k8s.git',
      repoDir: process.env.GITOPS_REPO_DIR || '/tmp/iot-k8s-main',
      mainBranch: process.env.GITOPS_MAIN_BRANCH || process.env.GITOPS_BRANCH || 'main',
      pat: process.env.GITOPS_PAT || '',
      authorName: process.env.GITOPS_COMMIT_AUTHOR_NAME || 'Iotistica Provisioning Bot',
      authorEmail: process.env.GITOPS_COMMIT_AUTHOR_EMAIL || 'info@iotistica.com',
      argocdProject: process.env.ARGOCD_PROJECT || 'default',
      argocdNamespace: process.env.ARGOCD_NAMESPACE || 'argocd',
    };

    this.git = simpleGit({
      baseDir: this.config.repoDir,
      config: [
        `user.name=${this.config.authorName}`,
        `user.email=${this.config.authorEmail}`,
      ],
    });

    // Select database provisioning provider (PROVISIONING_DB_PROVIDER=tigerdata|postgres|cnpg)
    const rawProvider = (process.env.PROVISIONING_DB_PROVIDER ?? 'tigerdata').toLowerCase();
    if (rawProvider === 'cnpg') {
      this.dbProvider = 'cnpg';
    } else if (rawProvider === 'postgres') {
      this.dbProvider = 'postgres';
    } else {
      this.dbProvider = 'tigerdata';
    }

    // Initialize provisioning services
    this.tigerDataService = new TigerDataService();
    if (this.dbProvider === 'postgres' || this.dbProvider === 'cnpg') {
      // postgres-provisioning-service is reused for cnpg: generateCnpgCredentials() only,
      // no DDL is executed (database + role creation is handled by CNPG operator + db-init job).
      this.postgresProvisioningService = new PostgresProvisioningService();
    }
    this.onePasswordService = new OnePasswordService();
    this.argoStatusService = new ArgoStatusService();

    if (!this.config.enabled) {
      logger.warn('GitOps mode disabled (GITOPS_ENABLED=false)');
    }

    if (!this.config.pat) {
      logger.warn('GITOPS_PAT not set - Git push will fail');
    }

    logger.info(`Database provisioning provider: ${this.dbProvider}`);
  }

  /**
   * Initialize Git repository (clone or pull)
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('Skipping GitOps initialization (disabled)');
      return;
    }

    try {
      // Check if directory exists and is a Git repository
      const dirExists = await fs.access(this.config.repoDir)
        .then(() => true)
        .catch(() => false);

      let isGitRepo = false;
      if (dirExists) {
        // Check if .git directory exists
        try {
          await fs.access(path.join(this.config.repoDir, '.git'));
          isGitRepo = true;
        } catch {
          isGitRepo = false;
        }
      }

      if (!dirExists || !isGitRepo) {
        // Clone repository (either directory doesn't exist or it's not a Git repo)
        if (dirExists && !isGitRepo) {
          logger.info('Directory exists but is not a Git repository, will clone', {
            repoDir: this.config.repoDir
          });

          try {
            await fs.rm(this.config.repoDir, { recursive: true, force: true });
          } catch (removeError: any) {
            // If the directory is busy (e.g., Docker volume mount), init in-place
            logger.warn('Unable to remove repository directory, initializing in-place', {
              repoDir: this.config.repoDir,
              error: removeError?.message
            });

            const urlWithAuth = this.config.repoUrl.replace(
              'https://',
              `https://${this.config.pat}@`
            );

            const initGit = simpleGit({
              baseDir: this.config.repoDir,
              config: [
                `user.name=${this.config.authorName}`,
                `user.email=${this.config.authorEmail}`,
              ],
            });

            await initGit.init();
            await initGit.addRemote('origin', urlWithAuth);
            await initGit.fetch('origin', this.config.mainBranch);
            await initGit.checkout(['-B', this.config.mainBranch, `origin/${this.config.mainBranch}`]);
            logger.info('Repository initialized in-place');

            this.initialized = true;
            return;
          }
        }

        logger.info('Cloning GitOps repository', { 
          repoUrl: this.config.repoUrl, 
          repoDir: this.config.repoDir 
        });

        const urlWithAuth = this.config.repoUrl.replace(
          'https://',
          `https://${this.config.pat}@`
        );

        await simpleGit().clone(urlWithAuth, this.config.repoDir);
        await this.git.fetch('origin', this.config.mainBranch);
        await this.git.checkout(['-B', this.config.mainBranch, `origin/${this.config.mainBranch}`]);
        logger.info('Repository cloned successfully');
      } else {
        // Pull latest changes from existing repository
        logger.info('Pulling latest changes from GitOps repository');
        // Ensure a clean working tree before pull to avoid untracked file conflicts
        await this.git.fetch('origin', this.config.mainBranch);
        await this.git.clean('f', ['-d', '-x']);
        await this.git.checkout(['-B', this.config.mainBranch, `origin/${this.config.mainBranch}`]);
        await this.git.reset(['--hard', `origin/${this.config.mainBranch}`]);
        await this.git.pull('origin', this.config.mainBranch);
        logger.info('Repository updated successfully');
      }

      this.initialized = true;
    } catch (error: any) {
      logger.error('Failed to initialize GitOps repository', { 
        error: error.message 
      });
      throw new Error(`GitOps initialization failed: ${error.message}`);
    }
  }

  /**
   * Sanitize customer ID for use as client ID
   * Uses SHA256 hash to prevent namespace collisions (critical for multi-tenant SaaS)
   * 
   * @param customerId - Internal customer ID (e.g., 47d48f27e0774d6a9f89a1c1dab9870a)
   * @returns 12-character hex hash (e.g., 3f558f4667c9)
   * 
   * Security: SHA256 ensures uniqueness across millions of customers
   * 12 hex chars = 48 bits = ~281 trillion combinations
   * 
   * IMPORTANT: This MUST match deployment-worker.ts sanitizeClientId() method
   */

  /**
   * Create Argo CD Application manifest for client
   */
  private generateApplicationManifest(data: ClientDeploymentData): any {
    return {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: {
        name: `client-${data.clientId}`,
      },
      spec: {
        destination: {
          namespace: data.namespace,
          server: 'https://kubernetes.default.svc',
        },
        source: {
          path: 'charts/iotistica',
          repoURL: this.config.repoUrl,
          targetRevision: this.config.mainBranch,
          helm: {
            valueFiles: [`values/client-${data.clientId}/values.yaml`],
          },
        },
        sources: [],
        project: this.config.argocdProject,
        syncPolicy: {
          automated: {
            prune: true,
            selfHeal: true,
          },
          syncOptions: [
            'CreateNamespace=true',
          ],
        },
      },
    };
  }

  /**
   * Generate client-specific values file from template
   */
  private async generateValuesFile(data: ClientDeploymentData): Promise<any> {
    // Load the template file
    const templatePath = path.join(__dirname, '..', 'templates', 'values.yaml');
    const templateContent = await fs.readFile(templatePath, 'utf-8');
    
    // Fetch the current stable release version from GitHub
    const releaseVersion = await releaseService.getCurrentStableRelease();
    logger.info('Using release version for deployment', { 
      releaseVersion, 
      clientId: data.clientId 
    });
    
    // Replace placeholders:
    // - {{CLIENT_ID}} with actual client ID (prefixed with "client-")
    // - {{RELEASE_VERSION}} with current stable release version
    // - {{CLIENT_BASE_DOMAIN}} with domain from environment (e.g., iotistica.com)
    // - {{BASE_DOMAIN}} with API base domain from environment (e.g., api.iotistica.com)
    const clientBaseDomain = process.env.CLIENT_BASE_DOMAIN || 'iotistica.com';
    const baseDomain = process.env.BASE_DOMAIN || 'api.iotistica.com';
    
    // Replace placeholders with actual values
    // Template now contains explicit "client-" prefix where needed (e.g., client-{{CLIENT_ID}})
    // Node-RED URL uses nr-{{CLIENT_ID}} without client- prefix
    let processedContent = templateContent
      .replace(/\{\{CLIENT_ID\}\}/g, data.clientId)
      .replace(/\{\{RELEASE_VERSION\}\}/g, releaseVersion)
      .replace(/\{\{CLIENT_BASE_DOMAIN\}\}/g, clientBaseDomain)
      .replace(/\{\{BASE_DOMAIN\}\}/g, baseDomain);
    
    // Parse YAML to object
    const values = yaml.load(processedContent) as any;
    
    return values;
  }

  /**
   * Deploy a new client instance
   * @param data - Client deployment configuration
   * @param job - Optional Bull job for retry context (used to determine final retry)
   */
  async deployClient(data: ClientDeploymentData, job?: Job): Promise<void> {
    if (!this.config.enabled) {
      logger.info('Skipping client deployment (GitOps disabled)');
      return;
    }

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      logger.info('Starting GitOps client deployment', {
        clientId: data.clientId,
        namespace: data.namespace,
        plan: data.plan,
      });

      // Ensure we have latest changes and are on the correct branch
      await this.git.fetch('origin', this.config.mainBranch);
      await this.git.clean('f', ['-d', '-x']);
      await this.git.checkout(['-B', this.config.mainBranch, `origin/${this.config.mainBranch}`]);
      await this.git.reset(['--hard', `origin/${this.config.mainBranch}`]);
      await this.git.pull('origin', this.config.mainBranch);

      // === STEP 1: Provision Database ===
      const providerLabel = this.dbProvider === 'cnpg' ? 'CNPG' : this.dbProvider === 'postgres' ? 'POSTGRES' : 'TIGERDATA';
      console.log('\n' + '-'.repeat(80));
      console.log(`STEP 1/4: PROVISION ${providerLabel} DATABASE`);
      console.log('-'.repeat(80));
      logger.info('Step 1: Provisioning database', {
        provider: this.dbProvider,
        customerId: data.customerId,
        namespace: data.namespace,
      });

      console.log(`Updating status: db_provisioning`);
      await CustomerModel.updateDeploymentStatus(data.customerId, 'db_provisioning');

      let dbResult: TigerDataDatabase;
      try {
        if (this.dbProvider === 'cnpg') {
          // CNPG: credential generation only — no DDL.
          // Database + role bootstrap is handled by the db-init Job in the client chart.
          console.log(`\nGenerating CNPG credentials for namespace: ${data.namespace}`);
          dbResult = this.postgresProvisioningService!.generateCnpgCredentials(data.namespace);
          console.log(`\nCNPG credentials generated:`);
          console.log(`   Username: ${dbResult.username}`);
          console.log(`   Database: ${dbResult.dbName}`);
          console.log(`   Pooler:   ${dbResult.host}:${dbResult.port}`);
        } else {
          console.log(`\nCreating ${providerLabel} database for namespace: ${data.namespace}`);

          if (this.dbProvider === 'postgres') {
            dbResult = await this.postgresProvisioningService!.provisionDatabase(data.namespace);
          } else {
            dbResult = await this.tigerDataService.provisionDatabase(data.namespace);
          }

          console.log(`\nDatabase provisioning response received:`);
          console.log(JSON.stringify(dbResult, null, 2));

          console.log(`\nDatabase provisioned:`);
          console.log(`   Service ID: ${dbResult.serviceId}`);
          console.log(`   Host: ${dbResult.host}`);
          console.log(`   Port: ${dbResult.port}`);
          console.log(`   Database: ${dbResult.dbName}`);
          console.log(`   Username: ${dbResult.username}`);
          console.log(`   Status: ${dbResult.status}`);
          logger.info('Database provisioned', {
            provider: this.dbProvider,
            serviceId: dbResult.serviceId,
            host: dbResult.host,
          });

          console.log(`\nWaiting for database to become ready...`);
          try {
            if (this.dbProvider === 'postgres') {
              await this.postgresProvisioningService!.waitUntilReady(dbResult.serviceId);
            } else {
              await this.tigerDataService.waitUntilReady(dbResult.serviceId);
            }
            console.log(`Database is ready!`);
            logger.info('Database is ready', { serviceId: dbResult.serviceId });
          } catch (waitError: any) {
            console.log(`\nDatabase status check timed out, but continuing deployment`);
            console.log(`   Password has been captured from initial provision response`);
            console.log(`   Deployment will continue with available credentials`);
            logger.warn('Database readiness timeout - continuing with captured credentials', {
              serviceId: dbResult.serviceId,
              hasPassword: !!dbResult.password,
              waitError: waitError.message,
            });
          }
        }

        // Update customer record with DB details
        console.log(`\nSaving database details to customer record...`);

        // When the DB already existed (retry scenario), provisionDatabase returns fullResponse: null.
        // Preserve any previously saved db_api_response (which contains the initial_password) so the
        // password recovery path below can still find it.
        let dbApiResponse = dbResult.fullResponse;
        if (!dbApiResponse) {
          const existingCustomer = await CustomerModel.getById(data.customerId);
          dbApiResponse = existingCustomer?.db_api_response ?? null;
          if (dbApiResponse) {
            logger.info('Preserved existing db_api_response for retry recovery', { customerId: data.customerId });
          }
        }

        await CustomerModel.updateTigerDataDetails(data.customerId, {
          db_service_id: dbResult.serviceId,
          db_host: dbResult.host,
          db_port: dbResult.port,
          db_name: dbResult.dbName,
          db_region: dbResult.region,
          db_provisioned_at: new Date(),
          db_api_response: dbApiResponse,
          db_initialized: false,
          deployment_status: 'db_ready',
          db_provider: this.dbProvider,
        });
        console.log(`Database details saved!`);
        console.log(`Status updated to: db_ready`);
        console.log('-'.repeat(80));

        // Update job progress (30 -> 35%)
        if (job) {
          await job.progress(35);
          console.log(`Job progress: 35% (DB provisioned)`);
        }

        logger.info('Database details saved to customer record', { provider: this.dbProvider });
      } catch (error: any) {
        console.log(`\nDatabase provisioning FAILED!`);
        console.log(`   Error: ${error.message}`);
        logger.error('Database provisioning failed', {
          provider: this.dbProvider,
          error: error.message,
          customerId: data.customerId,
        });

        await CustomerModel.updateDeploymentStatus(data.customerId, 'failed_db', {
          deploymentError: `${providerLabel} provisioning failed: ${error.message}`,
        });

        throw new Error(`${providerLabel} provisioning failed: ${error.message}`);
      }

      // === STEP 2: Build and Create Secret Bundle (Pre-DB) ===
      console.log('\n' + '-'.repeat(80));
      console.log('🔐 STEP 2/4: CREATE SECRET BUNDLE (SQL PLACEHOLDER)');
      console.log('-'.repeat(80));
      logger.info('Step 2: Creating secret bundle', { 
        customerId: data.customerId,
        namespace: data.namespace 
      });
      
      console.log(`🔄 Updating status: secret_creating`);
      await CustomerModel.updateDeploymentStatus(data.customerId, 'secret_creating');
      
      let secretItemIds: Record<string, string> = {};
      
      try {
        // Build all app secrets using templates
        console.log(`\n🔧 Pre-generating app secrets for client: ${data.clientId}`);
        const secretBuilder = new SecretBuilder(data.clientId).preGenerate([
          'mqtt',
          'api-jwt',
          'sql'  // SQL with PENDING placeholders
        ]);
        
        let allSecrets = secretBuilder.build();
        
        // Validate JWT secret matches provisioning's secret
        const provisioningJwtSecret = process.env.JWT_SECRET;
        const generatedJwtSecret = allSecrets['api-jwt']?.token;
        
        if (provisioningJwtSecret !== generatedJwtSecret) {
          throw new Error(
            `[GitOps] JWT secret mismatch detected!\n` +
            `  Provisioning: ${provisioningJwtSecret?.substring(0, 20)}...\n` +
            `  Generated: ${generatedJwtSecret?.substring(0, 20)}...\n` +
            `  This will cause authentication failures in customer deployment.`
          );
        }
        
        console.log(`✅ Secrets pre-generated from templates:`);
        console.log(`   ├─ mqtt (username, password)`);
        console.log(`   ├─ api-jwt (token - validated against provisioning secret)`);
        console.log(`   └─ sql (PENDING placeholders)`);
        
        // Fetch license from provisioning API
        console.log(`\n🔑 Fetching license from provisioning API...`);
        try {
          const provisioningUrl = process.env.BASE_URL || 'http://localhost:3100';
          
          // Fetch customer-specific JWT license
          const licenseRes = await axios.get(`${provisioningUrl}/api/licenses/${data.customerId}`);
          const { license } = licenseRes.data;
          
          // Add license to secret builder (only JWT token, public key is cluster-wide)
          secretBuilder.addLicenseCredentials(license);
          allSecrets = secretBuilder.build();
          
          console.log(`✅ License credential added`);
          console.log(`   JWT length: ${license.length} chars`);
        } catch (error: any) {
          console.error(`❌ Failed to fetch license from provisioning API: ${error.message}`);
          logger.error('License fetch failed', { error: error.message, customerId: data.customerId });
          throw new Error(`License generation failed: ${error.message}`);
        }
        
        // Create separate 1Password items for each component
        console.log(`\n🔑 Creating 1Password secret bundle...`);
        
        const apps = ['sql', 'mqtt', 'api-jwt', 'api-license'];
        for (let i = 0; i < apps.length; i++) {
          const app = apps[i];
          const appSecrets = allSecrets[app];
          
          if (!appSecrets) {
            console.warn(`   ⚠️  No secrets generated for: ${app}`);
            continue;
          }
          
          const isLast = i === apps.length - 1;
          const prefix = isLast ? '   └─' : '   ├─';
          
          console.log(`${prefix} ${app}-credentials-${data.clientId}`);
          
          secretItemIds[app] = await this.onePasswordService.createGenericSecretItem(
            data.clientId,
            app,
            appSecrets
          );
        }
        
        console.log(`\n✅ Secret bundle created (${apps.length} items)!`);
        logger.info('Secret bundle created', { 
          clientId: data.clientId,
          itemCount: Object.keys(secretItemIds).length,
          apps,
        });
        
        // Now update SQL credentials with actual DB info
        console.log(`\n🔄 Updating SQL credentials with TigerData info...`);
        
        // IMPORTANT: TigerData API returns initial_password on initial creation
        // If database already exists (retry scenario), check saved API response
        let dbPassword = dbResult.password;
        
        if (!dbPassword) {
          console.log(`⚠️  Password not in current response, checking saved database details...`);
          
          // Try to retrieve password from previously saved db_api_response
          const customer = await CustomerModel.getById(data.customerId);
          if (customer && customer.db_api_response) {
            console.log(`📦 Found saved database API response`);
            try {
              const savedResponse = typeof customer.db_api_response === 'string' 
                ? JSON.parse(customer.db_api_response) 
                : customer.db_api_response;
              
              dbPassword = savedResponse.initial_password || savedResponse.password;
              
              if (dbPassword) {
                console.log(`✅ Retrieved password from saved API response`);
                logger.info('Password retrieved from saved db_api_response', {
                  customerId: data.customerId,
                  serviceId: dbResult.serviceId,
                });
              }
            } catch (parseError: any) {
              logger.error('Failed to parse db_api_response', {
                error: parseError.message,
                customerId: data.customerId,
              });
            }
          }
        }
        
        if (!dbPassword) {
          // Still no password - check if this is the final Bull retry attempt
          const isFinalRetry = job && (job.attemptsMade + 1) >= (job.opts.attempts || 1);
          
          if (!isFinalRetry) {
            // Not the final retry - let Bull retry the job
            console.warn(`⚠️  Database password not available (database still provisioning)`);
            console.log(`🔄 Retry attempt ${job?.attemptsMade ? job.attemptsMade + 1 : 1}/${job?.opts.attempts || 1}`);
            console.log(`⏳ Letting Bull queue retry - waiting for database to reach READY status`);
            throw new Error(
              `Database ${dbResult.serviceId} not ready yet. ` +
              `Will retry (attempt ${job?.attemptsMade ? job.attemptsMade + 1 : 1}/${job?.opts.attempts || 1}). ` +
              `Database is still provisioning.`
            );
          }
          
          // This is the final retry - database still not READY after all attempts
          // This should be rare now that we capture password on first attempt
          console.warn(`\n⚠️  ════════════════════════════════════════════════════════════════`);
          console.warn(`⚠️  DATABASE PASSWORD UNAVAILABLE AFTER ALL RETRY ATTEMPTS`);
          console.warn(`⚠️  ════════════════════════════════════════════════════════════════`);
          console.log(`   Final retry attempt: ${job?.attemptsMade ? job.attemptsMade + 1 : 1}/${job?.opts.attempts || 1}`);
          console.log(`   Database Service ID: ${dbResult.serviceId}`);
          console.log(`   Database Host: ${dbResult.host}`);
          console.log(``);
          console.log(`📋 MANUAL INTERVENTION REQUIRED:`);
          console.log(`   1. Password was not captured from TigerData API response`);
          console.log(`   2. Saving deployment with placeholder password: "PENDING_MANUAL_UPDATE"`);
          console.log(`   3. Retrieve password from TigerData console`);
          console.log(`   4. Update 1Password secret with actual password`);
    
          console.log(`⚠️  ════════════════════════════════════════════════════════════════\n`);
          
          // Use placeholder password (rare case)
          dbPassword = 'PENDING_MANUAL_UPDATE';
          
          logger.warn('Database not ready after all retries - saving with placeholder password', {
            customerId: data.customerId,
            serviceId: dbResult.serviceId,
            host: dbResult.host,
            finalAttempt: job?.attemptsMade ? job.attemptsMade + 1 : 1,
            totalAttempts: job?.opts.attempts || 1,
          });
        }
        
        secretBuilder.addDbCredentials({
          user: dbResult.username,
          password: dbPassword,
          host: dbResult.host,
          port: dbResult.port,
          name: dbResult.dbName,
        });
        
        allSecrets = secretBuilder.build();
        
        await this.onePasswordService.updateGenericItem(
          secretItemIds.sql,
          allSecrets.sql
        );
        
        console.log(`✅ SQL credentials updated!`);
        console.log(`   Host: ${dbResult.host}`);
        console.log(`   Port: ${dbResult.port}`);
        console.log(`   Database: ${dbResult.dbName}`);
        
        const secretItemId = secretItemIds.sql; // Keep for backward compatibility
        
        console.log(`✅ Secret created successfully!`);
        console.log(`   Item ID: ${secretItemId}`);
        logger.info('1Password secret created', { 
          itemId: secretItemId,
          namespace: data.namespace 
        });

        // Update customer record with secret details
        console.log(`\n💾 Saving secret details to customer record...`);
        await CustomerModel.updateSecretDetails(data.customerId, {
          secret_item_id: secretItemId,
          secret_created_at: new Date(),
          deployment_status: 'secret_ready',
        });
        console.log(`✅ Secret details saved!`);
        console.log(`🔄 Status updated to: secret_ready`);
        console.log('-'.repeat(80));
        
        // Update job progress (35 → 45%)
        if (job) {
          await job.progress(45);
          console.log(`📊 Job progress: 45% (Secrets created)`);
        }
        
        logger.info('1Password details saved to database');
      } catch (error: any) {
        console.log(`\n❌ 1Password secret creation FAILED!`);
        console.log(`   Error: ${error.message}`);
        logger.error('1Password secret creation failed', { 
          error: error.message,
          customerId: data.customerId 
        });
        
        // Optionally cleanup TigerData database on secret creation failure
        // await this.tigerDataService.deleteDatabase(dbResult.serviceId);
        
        await CustomerModel.updateDeploymentStatus(data.customerId, 'failed_secret', {
          deploymentError: `1Password secret creation failed: ${error.message}`,
        });
        
        throw new Error(`1Password secret creation failed: ${error.message}`);
      }

      // Update data.postgres to use TigerData credentials
      // Note: Password now comes from 1Password CRD, not values file
      data.postgres = {
        username: dbResult.username,
        password: '', // Will be synced from 1Password via OnePasswordItem CRD
        database: dbResult.dbName,
      };

      // === STEP 3: Generate Application Manifest ===
      console.log('\n' + '-'.repeat(80));
      console.log('📝 STEP 3/4: GENERATE GITOPS MANIFESTS');
      console.log('-'.repeat(80));
      logger.info('Step 3: Generating Argo CD Application manifest');
      
      await CustomerModel.updateDeploymentStatus(data.customerId, 'deploying');

      // 1. Generate Application manifest
      const applicationManifest = this.generateApplicationManifest(data);
      const applicationPath = path.join(
        this.config.repoDir,
        'argocd',
        'clients',
        `client-${data.clientId}.yaml`
      );

      // Ensure directory exists
      await fs.mkdir(path.dirname(applicationPath), { recursive: true });

      // Write Application manifest
      await fs.writeFile(
        applicationPath,
        yaml.dump(applicationManifest, { indent: 2, lineWidth: -1 })
      );

      logger.info('Application manifest created', { path: applicationPath });

      // 2. Generate values file
      const valuesData = await this.generateValuesFile(data);
      
      const valuesDir = path.join(
        this.config.repoDir,
        'charts',
        'iotistica',
        'values',
        `client-${data.clientId}`
      );
      const valuesPath = path.join(valuesDir, 'values.yaml');

      // Ensure values directory exists
      await fs.mkdir(valuesDir, { recursive: true });

      // Write values file
      await fs.writeFile(
        valuesPath,
        yaml.dump(valuesData, { indent: 2, lineWidth: -1 })
      );

      logger.info('Values file created', { path: valuesPath });

      // 3. DB bootstrap now relies on the client chart db-init Job only.
      const filesToAdd = [
        `argocd/clients/client-${data.clientId}.yaml`,
        `charts/iotistica/values/client-${data.clientId}/values.yaml`,
      ];

      // 4. Commit changes
      await this.git.add(filesToAdd);

      const status = await this.git.status();
      if (status.files.length === 0) {
        logger.info('No changes to commit (deployment already exists)', {
          clientId: data.clientId,
        });
        return;
      }

      await this.git.commit(
        `Deploy client ${data.clientId} (${data.plan} plan)\n\n` +
        `Customer: ${data.email}\n` +
        `Namespace: ${data.namespace}\n` +
        `Plan: ${data.plan}`
      );

      logger.info('Changes committed', { clientId: data.clientId });

      // 4. Push to remote
      const urlWithAuth = this.config.repoUrl.replace(
        'https://',
        `https://${this.config.pat}@`
      );

      await this.git.addRemote('authenticated', urlWithAuth).catch(() => {
        // Remote already exists, update it
        return this.git.remote(['set-url', 'authenticated', urlWithAuth]);
      });

      await this.git.push('authenticated', this.config.mainBranch);

      logger.info('Changes pushed to remote', {
        clientId: data.clientId,
        branch: this.config.mainBranch,
      });
      
      // Update job progress (45 → 55%)
      if (job) {
        await job.progress(55);
        console.log(`📊 Job progress: 55% (Manifests committed and pushed)`);
      }

      // Mark deployment as complete (Auth0 handles authentication)
      await CustomerModel.updateDeploymentStatus(data.customerId, 'deployed');
      console.log('   ✅ Deployment status: deployed');
      
      logger.info('Provisioning complete - Auth0 authentication enabled', {
        clientId: data.clientId,
        customerId: data.customerId,
      });

    } catch (error: any) {
      logger.error('Client deployment failed', {
        clientId: data.clientId,
        error: error.message,
        stack: error.stack,
      });
      throw new Error(`Deployment failed for client ${data.clientId}: ${error.message}`);
    }
  }

  /**
   * Update an existing client instance
   */
  async updateClient(data: ClientDeploymentData): Promise<void> {
    // For now, update is the same as deploy (overwrites files)
    // In future, could add more granular update logic
    await this.deployClient(data);
  }

  /**
   * Delete a client instance (comprehensive cleanup)
   * 
   * COMPLETE DELETION FLOW:
   * 1. Remove Git manifests (Application + values)
   * 2. Commit + push (triggers Argo CD prune)
   * 3. Delete 1Password secret item
   * 4. Delete TigerData database
   * 
   * IDEMPOTENT: Checks if resources exist before attempting deletion
   * RESILIENT: Tries all cleanups, collects errors, reports at end
   */
  async deleteClient(clientId: string, customerId: string): Promise<void> {
    if (!this.config.enabled) {
      logger.info('Skipping client deletion (GitOps disabled)');
      return;
    }

    if (!this.initialized) {
      await this.initialize();
    }

    const errors: string[] = [];
    let gitDeleted = false;
    let secretDeleted = false;
    let dbDeleted = false;

    try {
      logger.info('Starting comprehensive client deletion', { clientId, customerId });
      console.log('\n' + '='.repeat(80));
      console.log('🗑️  COMPREHENSIVE CLIENT DELETION');
      console.log('='.repeat(80));
      console.log(`👤 Customer ID: ${customerId}`);
      console.log(`🏷️  Client ID: ${clientId}`);
      console.log('='.repeat(80) + '\n');

      // Get customer record to find resource IDs
      const customer = await CustomerModel.getById(customerId);
      if (!customer) {
        logger.warn('Customer not found during deletion', { customerId });
        console.log('⚠️  Customer record not found - proceeding with Git cleanup only');
      }

      // === STEP 1: Remove Git manifests ===
      console.log('📝 STEP 1/4: REMOVE GIT MANIFESTS');
      console.log('-'.repeat(80));
      
      try {
        // Ensure we have latest changes
        await this.git.pull('origin', this.config.mainBranch);

        // Remove Application manifest
        const applicationPath = path.join(
          this.config.repoDir,
          'argocd',
          'clients',
          `client-${clientId}.yaml`
        );

        // Remove values directory
        const valuesDir = path.join(
          this.config.repoDir,
          'charts',
          'iotistica',
          'values',
          `client-${clientId}`
        );

        // Check if files exist (idempotent check)
        const appExists = await fs.access(applicationPath).then(() => true).catch(() => false);
        const valuesExist = await fs.access(valuesDir).then(() => true).catch(() => false);

        if (!appExists && !valuesExist) {
          logger.info('Git manifests already deleted', { clientId });
          console.log('✅ Git manifests already deleted (idempotent)');
          gitDeleted = true;
        } else {
          // Remove files
          if (appExists) {
            await fs.unlink(applicationPath);
            console.log(`   ✅ Deleted: argocd/clients/client-${clientId}.yaml`);
            logger.info('Application manifest deleted', { path: applicationPath });
          }

          if (valuesExist) {
            await fs.rm(valuesDir, { recursive: true, force: true });
            console.log(`   ✅ Deleted: charts/iotistica/values/client-${clientId}/`);
            logger.info('Values directory deleted', { path: valuesDir });
          }

          // Commit changes
          await this.git.add([
            `argocd/clients/client-${clientId}.yaml`,
            `charts/iotistica/values/client-${clientId}/`,
          ]);

          await this.git.commit(
            `Delete client ${clientId}\n\n` +
            `Customer: ${customerId}\n` +
            `Reason: Subscription canceled`
          );

          console.log('   ✅ Changes committed');
          logger.info('Deletion committed', { clientId });

          // Push to remote
          const urlWithAuth = this.config.repoUrl.replace(
            'https://',
            `https://${this.config.pat}@`
          );

          await this.git.addRemote('authenticated', urlWithAuth).catch(() => {
            return this.git.remote(['set-url', 'authenticated', urlWithAuth]);
          });

          await this.git.push('authenticated', this.config.mainBranch);

          console.log('   ✅ Changes pushed to remote (Argo CD will prune resources)');
          logger.info('Deletion pushed to remote', { clientId, branch: this.config.mainBranch });
          gitDeleted = true;
        }
      } catch (error: any) {
        const errorMsg = `Git cleanup failed: ${error.message}`;
        errors.push(errorMsg);
        console.log(`   ❌ ${errorMsg}`);
        logger.error('Git cleanup failed', { clientId, error: error.message });
      }

      console.log('-'.repeat(80) + '\n');

      // === STEP 2: Delete Argo CD application (best effort) ===
      console.log('⏳ STEP 2/4: DELETE ARGO CD APPLICATION');
      console.log('-'.repeat(80));
      console.log('   ℹ️  Git deletion remains the source of truth; API delete accelerates teardown');

      try {
        const deleted = await this.argoStatusService.deleteApplication(clientId);
        if (deleted) {
          console.log(`   ✅ Argo CD application client-${clientId} deleted or already absent`);
        } else {
          throw new Error(`Argo CD API did not confirm deletion for client-${clientId}`);
        }
      } catch (error: any) {
        const errorMsg = `Argo CD application cleanup failed: ${error.message}`;
        errors.push(errorMsg);
        console.log(`   ❌ ${errorMsg}`);
        logger.error('Argo CD application cleanup failed', { clientId, error: error.message });
      }

      console.log('-'.repeat(80) + '\n');

      // === STEP 3: Delete 1Password secret bundle ===
      console.log('🔐 STEP 3/4: DELETE 1PASSWORD SECRET BUNDLE');
      console.log('-'.repeat(80));
      
      try {
        const clientTag = `client-${clientId}`;
        const deletedCount = await this.onePasswordService.deleteItemsByTag(clientTag);

        if (deletedCount > 0) {
          console.log(`   ✅ 1Password secret bundle deleted successfully (${deletedCount} item(s))`);
          logger.info('1Password secret bundle deleted', { clientId, clientTag, deletedCount });
          secretDeleted = true;
        } else if (customer?.secret_item_id) {
          console.log(`   ℹ️  No tagged bundle found, falling back to legacy secret item: ${customer.secret_item_id}`);
          await this.onePasswordService.deleteItem(customer.secret_item_id);
          console.log('   ✅ Legacy 1Password secret deleted successfully');
          logger.info('Legacy 1Password secret deleted', { itemId: customer.secret_item_id, clientId });
          secretDeleted = true;
        } else {
          console.log(`   ⚠️  No tagged bundle found for ${clientTag} and no legacy secret_item_id is stored`);
          logger.info('No 1Password secret bundle to delete', { customerId, clientId, clientTag });
          secretDeleted = true; // Consider it "deleted" if it never existed
        }
      } catch (error: any) {
        const errorMsg = `1Password cleanup failed: ${error.message}`;
        errors.push(errorMsg);
        console.log(`   ❌ ${errorMsg}`);
        logger.error('1Password cleanup failed', { customerId, error: error.message });
      }

      console.log('-'.repeat(80) + '\n');

      // === STEP 4: Delete database ===
      const deleteProviderLabel = this.dbProvider === 'postgres' ? 'POSTGRES' : 'TIGERDATA';
      console.log(`STEP 4/4: DELETE ${deleteProviderLabel} DATABASE`);
      console.log('-'.repeat(80));

      try {
        if (customer?.db_service_id) {
          console.log(`   Database Service ID: ${customer.db_service_id}`);
          if (this.dbProvider === 'postgres') {
            await this.postgresProvisioningService!.deleteDatabase(customer.db_service_id);
            console.log('   Postgres database deleted successfully');
            logger.info('Postgres database deleted', { serviceId: customer.db_service_id });
          } else {
            await this.tigerDataService.deleteDatabase(customer.db_service_id);
            console.log('   TigerData database deleted successfully');
            logger.info('TigerData database deleted', { serviceId: customer.db_service_id });
          }
          dbDeleted = true;
        } else {
          console.log('   No db_service_id found (already deleted or never created)');
          logger.info('No database to delete', { customerId });
          dbDeleted = true; // Consider it "deleted" if it never existed
        }
      } catch (error: any) {
        const errorMsg = `${deleteProviderLabel} cleanup failed: ${error.message}`;
        errors.push(errorMsg);
        console.log(`   ${errorMsg}`);
        logger.error(`${deleteProviderLabel} cleanup failed`, { customerId, error: error.message });
      }

      console.log('-'.repeat(80) + '\n');

      // === SUMMARY ===
      console.log('\n' + '='.repeat(80));
      console.log('DELETION SUMMARY');
      console.log('='.repeat(80));
      console.log(`   Git Manifests: ${gitDeleted ? 'Deleted' : 'Failed'}`);
      console.log(`   1Password Secret: ${secretDeleted ? 'Deleted' : 'Failed'}`);
      console.log(`   Database (${deleteProviderLabel}): ${dbDeleted ? 'Deleted' : 'Failed'}`);
      console.log('='.repeat(80) + '\n');

      // If any errors occurred, throw them
      if (errors.length > 0) {
        const errorSummary = `Deletion completed with ${errors.length} error(s):\n${errors.join('\n')}`;
        logger.error('Deletion completed with errors', { clientId, customerId, errors });
        throw new Error(errorSummary);
      }

      logger.info('Comprehensive deletion completed successfully', { clientId, customerId });
      console.log('COMPREHENSIVE DELETION COMPLETED SUCCESSFULLY\n');

    } catch (error: any) {
      logger.error('Client deletion failed', {
        clientId,
        customerId,
        error: error.message,
        stack: error.stack,
      });
      throw new Error(`Client deletion failed: ${error.message}`);
    }
  }
  /**
   * Check if GitOps is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// Singleton instance
export const gitOpsProvisioningService = new GitOpsProvisioningService();
