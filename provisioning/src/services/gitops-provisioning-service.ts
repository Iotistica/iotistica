/**
 * GitOps Provisioning Service
 * Manages client deployments via Git commits instead of direct Helm operations
 * 
 * Flow:
 * 1. Clone/pull iot-k8s-main repository
 * 2. Provision TigerData database
 * 3. Create 1Password secrets
 * 4. Generate Argo CD Application manifest
 * 5. Generate client-specific values file
 * 6. Commit and push to main branch
 * 7. Argo CD auto-syncs changes to Kubernetes
 */

import simpleGit, { SimpleGit } from 'simple-git';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { TigerDataService, TigerDataDatabase } from './tigerdata-service';
import { OnePasswordService } from './onepassword-service';
import { CustomerModel } from '../db/customer-model';
import { SecretBuilder } from './secret-builder';

interface ClientDeploymentData {
  clientId: string;           // Sanitized: dc5fec42901a (SHA256 hash)
  customerId: string;         // Internal ID: 47d48f27e0774d6a9f89a1c1dab9870a
  email: string;
  companyName: string;
  plan: 'starter' | 'professional' | 'enterprise';
  licenseKey: string;         // JWT token
  licensePublicKey: string;   // RSA public key
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
  private tigerDataService: TigerDataService;
  private onePasswordService: OnePasswordService;

  constructor() {
    // Load configuration from environment
    this.config = {
      enabled: process.env.GITOPS_ENABLED === 'true',
      repoUrl: process.env.GITOPS_REPO_URL || 'https://github.com/Iotistica/iot-k8s.git',
      repoDir: process.env.GITOPS_REPO_DIR || '/tmp/iot-k8s-main',
      mainBranch: process.env.GITOPS_MAIN_BRANCH || process.env.GITOPS_BRANCH || 'main',
      pat: process.env.GITOPS_PAT || '',
      authorName: process.env.GITOPS_COMMIT_AUTHOR_NAME || 'IoTistic Billing Bot',
      authorEmail: process.env.GITOPS_COMMIT_AUTHOR_EMAIL || 'billing@iotistic.com',
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

    // Initialize provisioning services
    this.tigerDataService = new TigerDataService();
    this.onePasswordService = new OnePasswordService();

    if (!this.config.enabled) {
      logger.warn('GitOps mode disabled (GITOPS_ENABLED=false)');
    }

    if (!this.config.pat) {
      logger.warn('GITOPS_PAT not set - Git push will fail');
    }
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
   * Generate random password for PostgreSQL
   */
  private generatePassword(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let password = '';
    for (let i = 0; i < 32; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

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
          path: 'charts/iotistica-app',
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
        },
      },
    };
  }

  /**
   * Generate client-specific values file
   */
  private generateValuesFile(data: ClientDeploymentData): any {
    // Check if using TigerData (external database) or embedded PostgreSQL
    const usingTigerData = data.postgres?.username && data.postgres.username !== 'postgres';
    
    // Default postgres credentials if not provided
    const postgresUsername = data.postgres?.username || 'postgres';
    const postgresPassword = data.postgres?.password || this.generatePassword();
    const postgresDatabase = data.postgres?.database || 'iotistic';

    return {
      global: {
        namespace: data.namespace,
      },
      license: {
        licenseKey: data.licenseKey,
        publicKey: data.licensePublicKey,
      },
      customer: {
        id: data.customerId,
        email: data.email,
        companyName: data.companyName,
        plan: data.plan,
      },
      redis: {
        enabled: true,
        image: {
          repository: 'redis',
          tag: '7-alpine',
        },
        port: 6379,
        maxMemory: '512mb',
        maxMemoryPolicy: 'allkeys-lru',
        persistence: {
          enabled: true,
        },
        storage: {
          size: '5Gi',
        },
        resources: {
          requests: {
            cpu: '100m',
            memory: '256Mi',
          },
          limits: {
            cpu: '500m',
            memory: '1Gi',
          },
        },
      },
      mosquitto: {
        enabled: true,
        image: {
          repository: 'iegomez/mosquitto-go-auth',
          tag: '3.0.0-mosquitto_2.0.18',
        },
        serviceType: 'ClusterIP',
        ports: {
          mqtt: 1883,
          mqtts: 8883,
          websocket: 9001,
        },
        resources: {
          requests: {
            cpu: '100m',
            memory: '64Mi',
          },
          limits: {
            cpu: '200m',
            memory: '128Mi',
          },
        },
        auth: {
          allowAnonymous: false,
          hasher: 'bcrypt',
          hasherCost: 10,
        },
        persistence: {
          enabled: true,
        },
      },
      mqttBroker: {
        protocol: 'mqtt',
        host: `client-${data.clientId}-release-iotistic-mosquitto.${data.namespace}.svc.cluster.local`,
        port: 1883,
        useTls: false,
      },
      api: {
        enabled: true,
        image: {
          repository: 'iotistic/api',
          tag: 'latest',
          pullPolicy: 'Always',
        },
        replicas: 1,
        port: 3002,
        serviceType: 'ClusterIP',
        corsOrigins: `https://${data.clientId}.${data.domain || 'iotistic.com'},http://localhost:3000`,
        resources: {
          requests: {
            cpu: '100m',
            memory: '256Mi',
          },
          limits: {
            cpu: '500m',
            memory: '512Mi',
          },
        },
        monitoring: {
          enabled: true,
          interval: '30s',
          scrapeTimeout: '10s',
        },
      },
      dashboard: {
        enabled: true,
        image: {
          repository: 'iotistic/dashboard',
          tag: 'latest',
          pullPolicy: 'Always',
        },
        replicas: 1,
        port: 3000,
        serviceType: 'ClusterIP',
        resources: {
          requests: {
            cpu: '50m',
            memory: '64Mi',
          },
          limits: {
            cpu: '200m',
            memory: '128Mi',
          },
        },
      },
      postgres: {
        // TigerData managed TimescaleDB (external database)
        // Credentials synced from 1Password via OnePasswordItem CRD: sql-credentials-{namespace}
        enabled: !usingTigerData,  // Disable embedded PostgreSQL if using TigerData
        // Embedded PostgreSQL configuration (used only if TigerData not configured)
        image: {
          repository: 'postgres',
          tag: '16-alpine',
        },
        port: 5432,
        database: postgresDatabase,
        username: postgresUsername,
        password: postgresPassword,  // Only used for embedded PostgreSQL
        persistence: {
          enabled: true,
          size: '10Gi',
        },
        resources: {
          requests: {
            cpu: '100m',
            memory: '256Mi',
          },
          limits: {
            cpu: '500m',
            memory: '1Gi',
          },
        },
      },
      ingress: {
        enabled: true,
        className: 'nginx',
        annotations: {
          'cert-manager.io/cluster-issuer': 'letsencrypt-production',
        },
        hosts: [
          {
            host: `${data.clientId}.${data.domain || 'iotistic.com'}`,
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                service: 'dashboard',
                port: 3000,
              },
              {
                path: '/api',
                pathType: 'Prefix',
                service: 'api',
                port: 3002,
              },
            ],
          },
        ],
        tls: [
          {
            secretName: `client-${data.clientId}-tls`,
            hosts: [`${data.clientId}.${data.domain || 'iotistic.com'}`],
          },
        ],
      },
      monitoring: data.monitoring || {
        enabled: true,
        dedicated: false,
        serviceMonitor: {
          enabled: true,
          interval: '30s',
          scrapeTimeout: '10s',
        },
      },
      billingExporter: {
        enabled: true,
        image: {
          repository: 'iotistic/billing-exporter',
          tag: 'latest',
        },
        customerId: data.customerId,
        pushgatewayUrl: 'http://prometheus-pushgateway.monitoring.svc.cluster.local:9091',
        interval: 300,
      },
      resourceQuota: {
        enabled: true,
        limits: {
          cpu: '2000m',
          memory: '4Gi',
          storage: '50Gi',
          pods: '20',
        },
      },
    };
  }

  /**
   * Deploy a new client instance
   */
  async deployClient(data: ClientDeploymentData): Promise<void> {
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

      // === STEP 1: Provision TigerData Database ===
      console.log('\n' + '-'.repeat(80));
      console.log('🏛️  STEP 1/4: PROVISION TIGERDATA DATABASE');
      console.log('-'.repeat(80));
      logger.info('Step 1: Provisioning TigerData database', { 
        customerId: data.customerId, 
        namespace: data.namespace 
      });
      
      console.log(`🔄 Updating status: db_provisioning`);
      await CustomerModel.updateDeploymentStatus(data.customerId, 'db_provisioning');
      
      let dbResult: TigerDataDatabase;
      try {
        console.log(`\n🚀 Creating TigerData service for namespace: ${data.namespace}`);
        dbResult = await this.tigerDataService.provisionDatabase(data.namespace);
        console.log(`✅ Database provisioned!`);
        console.log(`   Service ID: ${dbResult.serviceId}`);
        console.log(`   Host: ${dbResult.host}`);
        console.log(`   Port: ${dbResult.port}`);
        console.log(`   Database: ${dbResult.dbName}`);
        console.log(`   Username: ${dbResult.username}`);
        console.log(`   Status: ${dbResult.status}`);
        logger.info('TigerData database provisioned', { 
          serviceId: dbResult.serviceId,
          host: dbResult.host 
        });

        console.log(`\n⏳ Waiting for database to become ready...`);
        // Wait for database to become ready
        await this.tigerDataService.waitUntilReady(dbResult.serviceId);
        console.log(`✅ Database is ready!`);
        logger.info('TigerData database is ready', { serviceId: dbResult.serviceId });

        // Update customer record with DB details
        console.log(`\n💾 Saving database details to customer record...`);
        await CustomerModel.updateTigerDataDetails(data.customerId, {
          db_service_id: dbResult.serviceId,
          db_host: dbResult.host,
          db_port: dbResult.port,
          db_name: dbResult.dbName,
          db_region: dbResult.region,
          db_provisioned_at: new Date(),
          db_api_response: dbResult.fullResponse,
          db_initialized: false,
          deployment_status: 'db_ready',
        });
        console.log(`✅ Database details saved!`);
        console.log(`🔄 Status updated to: db_ready`);
        console.log('-'.repeat(80));
        
        logger.info('TigerData details saved to database');
      } catch (error: any) {
        console.log(`\n❌ TigerData provisioning FAILED!`);
        console.log(`   Error: ${error.message}`);
        logger.error('TigerData provisioning failed', { 
          error: error.message,
          customerId: data.customerId 
        });
        
        await CustomerModel.updateDeploymentStatus(data.customerId, 'failed_db', {
          deploymentError: `TigerData provisioning failed: ${error.message}`,
        });
        
        throw new Error(`TigerData provisioning failed: ${error.message}`);
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
          'redis',
          'mqtt',
          'openai',
          'api-jwt',
          'sql'   // SQL with PENDING placeholders
        ]);
        
        let allSecrets = secretBuilder.build();
        
        console.log(`✅ Secrets pre-generated from templates:`);
        console.log(`   ├─ redis (host, password, port_ext, port)`);
        console.log(`   ├─ mqtt (username, password)`);
        console.log(`   ├─ openai (key)`);
        console.log(`   ├─ api-jwt (secret)`);
        console.log(`   └─ sql (PENDING placeholders)`);
        
        // Create separate 1Password items for each component
        console.log(`\n🔑 Creating 1Password secret bundle...`);
        
        const apps = ['sql', 'redis', 'mqtt', 'openai', 'api-jwt'];
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
        secretBuilder.addDbCredentials({
          user: dbResult.username,
          password: dbResult.password,
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
      const valuesData = this.generateValuesFile(data);
      const valuesDir = path.join(
        this.config.repoDir,
        'charts',
        'iotistica-app',
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

      // 3. Commit changes
      await this.git.add([
        `argocd/clients/client-${data.clientId}.yaml`,
        `charts/iotistica-app/values/client-${data.clientId}/values.yaml`,
      ]);

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

    } catch (error: any) {
      logger.error('GitOps client deployment failed', {
        clientId: data.clientId,
        error: error.message,
        stack: error.stack,
      });
      throw new Error(`GitOps deployment failed: ${error.message}`);
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
          'iotistica-app',
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
            console.log(`   ✅ Deleted: charts/iotistica-app/values/client-${clientId}/`);
            logger.info('Values directory deleted', { path: valuesDir });
          }

          // Commit changes
          await this.git.add([
            `argocd/clients/client-${clientId}.yaml`,
            `charts/iotistica-app/values/client-${clientId}/`,
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

      // === STEP 2: Wait for Argo CD prune (optional, best effort) ===
      console.log('⏳ STEP 2/4: ARGO CD PRUNE (OPTIONAL)');
      console.log('-'.repeat(80));
      console.log('   ℹ️  Argo CD will automatically prune resources when Application is deleted');
      console.log('   ℹ️  Skipping explicit wait (resources will be cleaned up asynchronously)');
      console.log('-'.repeat(80) + '\n');

      // === STEP 3: Delete 1Password secret ===
      console.log('🔐 STEP 3/4: DELETE 1PASSWORD SECRET');
      console.log('-'.repeat(80));
      
      try {
        if (customer?.secret_item_id) {
          console.log(`   🔑 Secret Item ID: ${customer.secret_item_id}`);
          await this.onePasswordService.deleteItem(customer.secret_item_id);
          console.log('   ✅ 1Password secret deleted successfully');
          logger.info('1Password secret deleted', { itemId: customer.secret_item_id });
          secretDeleted = true;
        } else {
          console.log('   ⚠️  No secret_item_id found (already deleted or never created)');
          logger.info('No 1Password secret to delete', { customerId });
          secretDeleted = true; // Consider it "deleted" if it never existed
        }
      } catch (error: any) {
        const errorMsg = `1Password cleanup failed: ${error.message}`;
        errors.push(errorMsg);
        console.log(`   ❌ ${errorMsg}`);
        logger.error('1Password cleanup failed', { customerId, error: error.message });
      }

      console.log('-'.repeat(80) + '\n');

      // === STEP 4: Delete TigerData database ===
      console.log('🗄️  STEP 4/4: DELETE TIGERDATA DATABASE');
      console.log('-'.repeat(80));
      
      try {
        if (customer?.db_service_id) {
          console.log(`   🗄️  Database Service ID: ${customer.db_service_id}`);
          await this.tigerDataService.deleteDatabase(customer.db_service_id);
          console.log('   ✅ TigerData database deleted successfully');
          logger.info('TigerData database deleted', { serviceId: customer.db_service_id });
          dbDeleted = true;
        } else {
          console.log('   ⚠️  No db_service_id found (already deleted or never created)');
          logger.info('No TigerData database to delete', { customerId });
          dbDeleted = true; // Consider it "deleted" if it never existed
        }
      } catch (error: any) {
        const errorMsg = `TigerData cleanup failed: ${error.message}`;
        errors.push(errorMsg);
        console.log(`   ❌ ${errorMsg}`);
        logger.error('TigerData cleanup failed', { customerId, error: error.message });
      }

      console.log('-'.repeat(80) + '\n');

      // === SUMMARY ===
      console.log('\n' + '='.repeat(80));
      console.log('📊 DELETION SUMMARY');
      console.log('='.repeat(80));
      console.log(`   Git Manifests: ${gitDeleted ? '✅ Deleted' : '❌ Failed'}`);
      console.log(`   1Password Secret: ${secretDeleted ? '✅ Deleted' : '❌ Failed'}`);
      console.log(`   TigerData Database: ${dbDeleted ? '✅ Deleted' : '❌ Failed'}`);
      console.log('='.repeat(80) + '\n');

      // If any errors occurred, throw them
      if (errors.length > 0) {
        const errorSummary = `Deletion completed with ${errors.length} error(s):\n${errors.join('\n')}`;
        logger.error('Deletion completed with errors', { clientId, customerId, errors });
        throw new Error(errorSummary);
      }

      logger.info('Comprehensive deletion completed successfully', { clientId, customerId });
      console.log('✅ COMPREHENSIVE DELETION COMPLETED SUCCESSFULLY\n');

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
