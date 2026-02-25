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
import { logger } from '../utils/logger';
import { TigerDataService, TigerDataDatabase } from './tigerdata-service';
import { OnePasswordService } from './onepassword-service';
import { CustomerModel } from '../db/customer-model';

interface ClientDeploymentData {
  clientId: string;           // Sanitized: dc5fec42
  customerId: string;         // Original: cust_dc5fec42901a...
  email: string;
  companyName: string;
  plan: 'starter' | 'professional' | 'enterprise';
  licenseKey: string;         // JWT token
  licensePublicKey: string;   // RSA public key
  namespace: string;          // client-dc5fec42
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
   * Example: cust_dc5fec42901a... -> dc5fec42
   */
  private sanitizeClientId(customerId: string): string {
    return customerId.replace(/^cust_/, '').substring(0, 8);
  }

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
        
        await CustomerModel.updateDeploymentStatus(data.customerId, 'failed', {
          deploymentError: `TigerData provisioning failed: ${error.message}`,
        });
        
        throw new Error(`TigerData provisioning failed: ${error.message}`);
      }

      // === STEP 2: Create 1Password Secrets ===
      console.log('\n' + '-'.repeat(80));
      console.log('🔐 STEP 2/4: CREATE 1PASSWORD SECRETS');
      console.log('-'.repeat(80));
      logger.info('Step 2: Creating 1Password secrets', { 
        customerId: data.customerId,
        namespace: data.namespace 
      });
      
      console.log(`🔄 Updating status: secret_creating`);
      await CustomerModel.updateDeploymentStatus(data.customerId, 'secret_creating');
      
      try {
        console.log(`\n🔑 Creating 1Password item: sql-credentials-${data.namespace}`);
        console.log(`   Host: ${dbResult.host}`);
        console.log(`   Port: ${dbResult.port}`);
        console.log(`   Username: ${dbResult.username}`);
        console.log(`   Database: ${dbResult.dbName}`);
        
        const secretItemId = await this.onePasswordService.createSecretItem(data.namespace, {
          host: dbResult.host,
          port: dbResult.port,
          username: dbResult.username,
          password: dbResult.password,
          database: dbResult.dbName,
        });
        
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
        
        await CustomerModel.updateDeploymentStatus(data.customerId, 'failed', {
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
   * Delete a client instance
   */
  async deleteClient(clientId: string, customerId: string): Promise<void> {
    if (!this.config.enabled) {
      logger.info('Skipping client deletion (GitOps disabled)');
      return;
    }

    if (!this.initialized) {
      await this.initialize();
    }

    try {
      logger.info('Starting GitOps client deletion', { clientId });

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

      // Check if files exist
      const appExists = await fs.access(applicationPath).then(() => true).catch(() => false);
      const valuesExist = await fs.access(valuesDir).then(() => true).catch(() => false);

      if (!appExists && !valuesExist) {
        logger.info('Client already deleted', { clientId });
        return;
      }

      // Remove files
      if (appExists) {
        await fs.unlink(applicationPath);
        logger.info('Application manifest deleted', { path: applicationPath });
      }

      if (valuesExist) {
        await fs.rm(valuesDir, { recursive: true, force: true });
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

      logger.info('Deletion pushed to remote', {
        clientId,
        branch: this.config.mainBranch,
      });

    } catch (error: any) {
      logger.error('GitOps client deletion failed', {
        clientId,
        error: error.message,
        stack: error.stack,
      });
      throw new Error(`GitOps deletion failed: ${error.message}`);
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
