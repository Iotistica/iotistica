import crypto from 'crypto';
import express, { Request, Response } from 'express';
import { Client as PgClient } from 'pg';
import { deploymentQueue, DeploymentJobData, DeleteJobData } from '../services/deployment-queue';
import { APIMigrationService, PostgresProvisioningService } from '../services/postgres-provisioning-service';
import { CustomerModel } from '../db/customer-model';
import { SubscriptionModel } from '../db/subscription-model';
import { StripeService } from '../services/stripe-service';
import { Auth0UserService } from '../services/auth0-user-service';
import { query } from '../db/connection';
import { logger } from '../utils/logger';

/**
 * Derive the 12-char client ID used for namespaces/paths.
 * Must match deployment-worker.ts sanitizeClientId().
 */
function deriveClientId(customerId: string): string {
  return crypto.createHash('sha256').update(customerId).digest('hex').substring(0, 12);
}

const router = express.Router();

/**
 * Insert an audit log entry into the billing database
 * 
 * @param action - The action being logged (e.g., "template_rebuild")
 * @param metadata - Additional metadata as JSON
 * @param request - Express request object (for IP and user agent)
 */
async function insertAuditLog(
  action: string,
  metadata: any,
  request: Request
): Promise<void> {
  try {
    const client = new PgClient({
      connectionString: process.env.DATABASE_URL,
    });

    await client.connect();

    await client.query(
      `INSERT INTO audit_log (action, customer_id, user_id, metadata, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        action,
        null, // customer_id - null for admin actions
        null, // user_id - would need to extract from auth token
        JSON.stringify(metadata),
        request.ip || null,
        request.get('user-agent') || null,
      ]
    );

    logger.info('[audit] Log inserted', { action, ip: request.ip });
  } catch (error) {
    // Don't fail the request if audit logging fails, just log the error
    logger.error('[audit] Failed to insert audit log', {
      error: error instanceof Error ? error.message : String(error),
      action,
    });
  } finally {
    // Don't await, just let it close in background
    // This prevents audit logging from blocking the response
  }
}

/**
 * GET /api/admin/jobs
 * List all jobs in the deployment queue
 */
router.get('/jobs', async (req: Request, res: Response) => {
  try {
    const queue = deploymentQueue.getQueue();
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaiting(),
      queue.getActive(),
      queue.getCompleted(),
      queue.getFailed(),
    ]);

    const allJobs = [...waiting, ...active, ...completed, ...failed];
    
    const jobsWithState = await Promise.all(
      allJobs.map(async (job) => ({
        id: job.id,
        type: job.name,
        data: job.data,
        progress: job.progress(),
        state: await job.getState(),
        attempts: job.attemptsMade,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason
      }))
    );

    res.json({ jobs: jobsWithState });
  } catch (error) {
    console.error('❌ Error fetching jobs:', error);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});

/**
 * GET /api/admin/jobs/:jobId
 * Get status of a specific job
 */
router.get('/jobs/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const job = await deploymentQueue.getJob(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const state = await job.getState();
    const progress = job.progress();
    
    res.json({
      id: job.id,
      type: job.name,
      data: job.data,
      state,
      progress,
      attempts: job.attemptsMade,
      maxAttempts: job.opts.attempts || 3,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      stacktrace: job.stacktrace,
      returnvalue: job.returnvalue
    });
  } catch (error) {
    console.error('❌ Error fetching job:', error);
    res.status(500).json({ error: 'Failed to fetch job' });
  }
});

/**
 * POST /api/admin/template/rebuild
 * Rebuild the template database from latest GitHub migrations
 * 
 * This endpoint:
 * 1. Fetches latest API migrations from GitHub (api/database/migrations/*.sql)
 * 2. Drops the existing template database
 * 3. Creates a fresh template and applies all migrations
 * 4. Locks the template to prevent accidental connections
 * 
 * Query parameters:
 *   - skip_drop=true  : Don't drop existing template, just apply migrations (if supported)
 * 
 * Response: Success message with template metadata
 */
router.post('/template/rebuild', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const skipDrop = req.query.skip_drop === 'true';

  try {
    logger.info('[admin] Template rebuild requested', { skipDrop });

    // Step 1: Fetch migrations from GitHub
    logger.info('[admin] Fetching migrations from GitHub...');
    const migrationService = new APIMigrationService();
    const schemaSql = await migrationService.fetchLatestMigrations();
    const fetchDuration = Date.now() - startTime;
    
    // Calculate SHA256 checksum of migration bundle for schema drift detection
    const crypto = require('crypto');
    const schemaHash = crypto.createHash('sha256').update(schemaSql).digest('hex');
    
    // Get the number of migration files that were loaded
    const migrationCount = migrationService.getMigrationCount();
    
    logger.info('[admin] Migrations fetched', { 
      durationMs: fetchDuration,
      sqlBytes: schemaSql.length,
      migrationCount,
      schemaHash
    });

    // Step 1.5: Fetch Git version metadata
    logger.info('[admin] Fetching Git version metadata...');
    const versionMetadata = await migrationService.getVersionMetadata();
    logger.info('[admin] Version metadata retrieved', {
      commit: versionMetadata.commitShort,
      tag: versionMetadata.tag || 'none',
      branch: versionMetadata.branch,
    });

    // Step 2: Initialize PostgreSQL provisioning service
    const pgService = new PostgresProvisioningService();
    const templateName = pgService.getTemplateDatabaseName() || 'template_iotistica';

    // Step 3: Drop existing template (unless explicitly skipped)
    if (!skipDrop) {
      logger.info('[admin] Dropping existing template database...');
      await pgService.dropTemplateDatabase();
      logger.info('[admin] Template database dropped');
    }

    // Step 4: Create fresh template and apply migrations
    logger.info('[admin] Creating and provisioning template database...');
    await pgService.provisionTemplateDatabase(schemaSql);
    
    // Step 5: Insert schema version metadata into template
    logger.info('[admin] Inserting schema version metadata...');
    await pgService.insertVersionMetadata(templateName, versionMetadata, migrationCount, schemaHash);
    
    const totalDuration = Date.now() - startTime;
    logger.info('[admin] Template database ready', { 
      totalDurationMs: totalDuration,
      templateName,
      version: versionMetadata.commitShort,
    });

    const responseData = {
      success: true,
      message: 'Template database successfully rebuilt from latest migrations',
      metadata: {
        templateName,
        totalDurationMs: totalDuration,
        sqlBytes: schemaSql.length,
        migrationCount,
        timestamp: new Date().toISOString(),
      },
      version: {
        commit: versionMetadata.commitShort,
        commitHash: versionMetadata.commitHash,
        tag: versionMetadata.tag,
        branch: versionMetadata.branch,
        repoTimestamp: versionMetadata.timestamp,
      },
      repository: migrationService.getMetadata(),
    };

    // Insert audit log entry (non-blocking)
    insertAuditLog(
      'template_rebuild',
      {
        templateName,
        durationMs: totalDuration,
        migrationCount,
        commitHash: versionMetadata.commitShort,
        tag: versionMetadata.tag,
        skipDrop,
        success: true,
      },
      req
    ).catch((err) => logger.error('[audit] Failed to log template rebuild', { error: err }));

    res.json(responseData);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;
    
    logger.error('[admin] Template rebuild failed', {
      error: errorMsg,
      durationMs,
    });
    
    // Insert audit log entry for failure (non-blocking)
    insertAuditLog(
      'template_rebuild_failed',
      {
        durationMs,
        skipDrop,
        success: false,
        error: errorMsg,
      },
      req
    ).catch((err) => logger.error('[audit] Failed to log template rebuild failure', { error: err }));

    res.status(500).json({
      error: 'Template rebuild failed',
      message: errorMsg,
    });
  }
});

/**
 * GET /api/admin/template/status
 * Get current template database status and metadata
 * 
 * Returns:
 * - Template existence and properties (is_template, allow_connections)
 * - Table count in template
 * - Last rebuild time (if available)
 * - Repository sync metadata
 */
router.get('/template/status', async (req: Request, res: Response) => {
  try {
    const pgService = new PostgresProvisioningService();
    const status = await pgService.getTemplateStatus();

    res.json({
      success: true,
      template: {
        name: pgService.getTemplateDatabaseName() || 'template_iotistica',
        ...status,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[admin] Template status check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: 'Failed to fetch template status',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * POST /api/admin/test/provision-database
 * TEST ENDPOINT: Provision a test database from template
 * 
 * Query Parameters:
 * - namespace: Customer namespace for the database (e.g., "test-customer-001")
 * 
 * Returns:
 * - Database name, owner role, creation time
 * - Schema info (table count inherited from template)
 * - Connection details for testing
 * 
 * This endpoint validates the complete provisioning workflow including:
 * - Connection termination to template (if needed)
 * - Database creation from template
 * - Role/permission setup
 * - Verification that new database is ready for use
 */
router.post('/test/provision-database', async (req: Request, res: Response) => {
  try {
    const { namespace } = req.query;

    if (!namespace || typeof namespace !== 'string') {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: 'namespace query parameter is required (e.g., ?namespace=test-customer-001)',
      });
    }

    const startTime = Date.now();
    logger.info('[admin] Starting database provisioning test', {
      namespace,
      timestamp: new Date().toISOString(),
    });

    const pgService = new PostgresProvisioningService();

    // Provision the database (this includes robust connection termination logic)
    const provisionedDb = await pgService.provisionDatabase(namespace);

    const duration = Date.now() - startTime;

    logger.info('[admin] Database provisioning test completed successfully', {
      namespace,
      duration,
      username: provisionedDb.username,
    });

    const responseData = {
      success: true,
      message: 'Database provisioned successfully from template',
      database: {
        namespace,
        databaseName: provisionedDb.dbName,
        ownerRole: provisionedDb.username,
        password: provisionedDb.password,
        createdAt: new Date().toISOString(),
        connectionString: `postgresql://${provisionedDb.username}:${provisionedDb.password}@postgres:5432/${provisionedDb.dbName}`,
        externalConnectionString: `postgresql://${provisionedDb.username}:${provisionedDb.password}@localhost:5433/${provisionedDb.dbName}`,
      },
      metadata: {
        template: pgService.getTemplateDatabaseName(),
        duration: `${duration}ms`,
        sourceMethod: 'CREATE DATABASE ... TEMPLATE',
      },
      validationSteps: [
        '✓ Template database exists and is locked',
        '✓ Active connections to template terminated successfully',
        '✓ New database created from template',
        '✓ Owner role provisioned',
        '✓ Permissions granted',
        '✓ Database ready for schema migrations',
      ],
      nextSteps: [
        'Connect to database: psql $connectionString',
        'Run migrations: npx knex migrate:latest',
        'Test data insert: INSERT INTO your_table VALUES (...)',
        'Grant application user permissions: GRANT ALL ON SCHEMA public TO app_user',
      ],
    };

    // Insert audit log entry (non-blocking)
    insertAuditLog(
      'test_provision_database',
      {
        namespace,
        durationMs: duration,
        databaseName: provisionedDb.dbName,
        username: provisionedDb.username,
        success: true,
      },
      req
    ).catch((err) => logger.error('[audit] Failed to log provision test', { error: err }));

    res.json(responseData);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const namespace = req.query.namespace as string || 'unknown';

    logger.error('[admin] Database provisioning test failed', {
      error: errorMsg,
      errorCode: (error as any)?.code,
      errorDetail: (error as any)?.detail,
      timestamp: new Date().toISOString(),
      namespace,
    });

    // Insert audit log entry for failure (non-blocking)
    insertAuditLog(
      'test_provision_database_failed',
      {
        namespace,
        success: false,
        error: errorMsg,
        errorCode: (error as any)?.code,
      },
      req
    ).catch((err) => logger.error('[audit] Failed to log provision test failure', { error: err }));

    res.status(500).json({
      success: false,
      error: 'Database provisioning failed',
      message: errorMsg,
      details: {
        code: (error as any)?.code,
        detail: (error as any)?.detail,
        hint: (error as any)?.hint,
      },
      troubleshooting: [
        'Check PostgreSQL is running: docker ps | grep postgres',
        'Verify template exists: GET /api/admin/template/status',
        'Check template is locked: SELECT datistemplate, datallowconn FROM pg_database WHERE datname="template_iotistica"',
        'Review logs: docker logs provisioning-api --tail 50',
      ],
    });
  }
});

// ─── Customer Management ────────────────────────────────────────────────────

/**
 * GET /api/admin/customers
 * List customers with optional search and pagination.
 * Query params: search, status, limit (default 50), offset (default 0)
 */
router.get('/customers', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';

    const params: unknown[] = [];
    const conditions: string[] = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(c.email ILIKE $${params.length} OR c.company_name ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`c.deployment_status = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM customers c ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    params.push(limit, offset);
    const result = await query<Record<string, unknown>>(
      `SELECT c.*,
              s.plan,
              s.status AS subscription_status,
              s.trial_ends_at
         FROM customers c
         LEFT JOIN LATERAL (
           SELECT plan, status, trial_ends_at
           FROM subscriptions
           WHERE customer_id = c.customer_id
           ORDER BY created_at DESC
           LIMIT 1
         ) s ON TRUE
         ${where}
         ORDER BY c.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ customers: result.rows, total, limit, offset });
  } catch (error) {
    logger.error('[admin] Failed to list customers', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to list customers' });
  }
});

/**
 * GET /api/admin/customers/:id
 * Get a single customer by customer_id, including latest subscription.
 */
router.get('/customers/:id', async (req: Request, res: Response) => {
  try {
    const customer = await CustomerModel.getById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const subscription = await SubscriptionModel.getByCustomerId(req.params.id);
    res.json({ customer, subscription });
  } catch (error) {
    logger.error('[admin] Failed to get customer', { id: req.params.id, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get customer' });
  }
});

/**
 * POST /api/admin/customers
 * Manually create a customer using the Stripe-backed onboarding path.
 * Body: { email, company_name, full_name?, plan? }
 */
router.post('/customers', async (req: Request, res: Response) => {
  try {
    const { email, company_name, full_name, plan } = req.body as {
      email: string;
      company_name?: string;
      full_name?: string;
      plan?: 'trial' | 'starter' | 'professional' | 'enterprise';
    };

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'email is required' });
    }

    const requestedPlan = plan || 'trial';
    if (!['trial', 'starter', 'professional', 'enterprise'].includes(requestedPlan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const normalizedPlan = requestedPlan === 'trial' ? 'starter' : requestedPlan;

    const existing = await CustomerModel.getByEmail(email);
    if (existing) return res.status(409).json({ error: 'A customer with this email already exists' });

    const auth0Provisioning = await Auth0UserService.ensureUserAndSendPasswordSetup({
      email,
      fullName: full_name,
      username: email,
    });

    const customer = await CustomerModel.create({ email, companyName: company_name, fullName: full_name });

    if (auth0Provisioning.auth0Sub) {
      await query(
        `INSERT INTO user_tenant_roles (auth0_sub, customer_id, role, created_by, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (auth0_sub, customer_id) DO NOTHING`,
        [auth0Provisioning.auth0Sub, customer.customer_id, 'admin', 'admin_create_customer']
      );
    } else {
      logger.warn('[admin] Auth0 user created but auth0_sub was not resolved; role mapping will occur on first login', {
        customerId: customer.customer_id,
        email,
      });
    }

    const subscription = await StripeService.createTrialSubscription({
      customerId: customer.customer_id,
      plan: normalizedPlan,
      trialDays: 14,
      source: 'admin_create_customer',
    });

    insertAuditLog(
      'admin_create_customer',
      {
        customerId: customer.customer_id,
        email,
        requestedPlan,
        plan: normalizedPlan,
        auth0UserCreated: auth0Provisioning.created,
        auth0PasswordSetupEmailSent: auth0Provisioning.passwordSetupEmailSent,
        auth0Sub: auth0Provisioning.auth0Sub || null,
        stripeSubscriptionId: subscription.stripe_subscription_id,
      },
      req
    ).catch(() => {});

    res.status(201).json({
      customer,
      subscription,
      auth0: auth0Provisioning,
    });
  } catch (error) {
    logger.error('[admin] Failed to create customer', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

/**
 * PATCH /api/admin/customers/:id
 * Update editable customer fields.
 * Body: { company_name?, full_name?, is_active? }
 */
router.patch('/customers/:id', async (req: Request, res: Response) => {
  try {
    const customer = await CustomerModel.getById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { company_name, full_name, is_active } = req.body as {
      company_name?: string;
      full_name?: string;
      is_active?: boolean;
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (company_name !== undefined) { values.push(company_name); setClauses.push(`company_name = $${values.length}`); }
    if (full_name !== undefined) { values.push(full_name); setClauses.push(`full_name = $${values.length}`); }
    if (is_active !== undefined) { values.push(is_active); setClauses.push(`is_active = $${values.length}`); }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    values.push(req.params.id);

    const result = await query<Record<string, unknown>>(
      `UPDATE customers SET ${setClauses.join(', ')} WHERE customer_id = $${values.length} RETURNING *`,
      values
    );

    insertAuditLog('admin_update_customer', { customerId: req.params.id, setClauses }, req).catch(() => {});

    res.json({ customer: result.rows[0] });
  } catch (error) {
    logger.error('[admin] Failed to update customer', { id: req.params.id, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

/**
 * DELETE /api/admin/customers/:id
 * Soft-delete a customer (sets is_active=false, deployment_status='cancelled').
 */
router.delete('/customers/:id', async (req: Request, res: Response) => {
  try {
    const customer = await CustomerModel.getById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    await query(
      `UPDATE customers SET is_active = false, deployment_status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE customer_id = $1`,
      [req.params.id]
    );

    insertAuditLog('admin_delete_customer', { customerId: req.params.id }, req).catch(() => {});

    res.json({ success: true });
  } catch (error) {
    logger.error('[admin] Failed to delete customer', { id: req.params.id, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

/**
 * GET /api/admin/customers/:id/jobs
 * Get all Bull jobs for a given customer.
 */
router.get('/customers/:id/jobs', async (req: Request, res: Response) => {
  try {
    const jobs = await deploymentQueue.getCustomerJobs(req.params.id);

    const jobsWithState = await Promise.all(
      jobs.map(async (job) => ({
        id: job.id,
        type: job.name,
        data: job.data,
        progress: job.progress(),
        state: await job.getState(),
        attempts: job.attemptsMade,
        failedReason: job.failedReason,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
      }))
    );

    res.json({ jobs: jobsWithState });
  } catch (error) {
    logger.error('[admin] Failed to get customer jobs', { id: req.params.id, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to get jobs' });
  }
});

/**
 * POST /api/admin/customers/:id/provision
 * Enqueue a deploy-customer-stack job for a customer.
 */
router.post('/customers/:id/provision', async (req: Request, res: Response) => {
  try {
    const customer = await CustomerModel.getById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const hasActive = await deploymentQueue.hasActiveDeploymentJobs(req.params.id);
    if (hasActive) return res.status(409).json({ error: 'Customer already has an active deployment job' });

    const subscription = await SubscriptionModel.getByCustomerId(req.params.id);
    const clientId = deriveClientId(customer.customer_id);

    const jobData: DeploymentJobData = {
      customerId: customer.customer_id,
      email: customer.email,
      companyName: customer.company_name || '',
      namespace: customer.instance_namespace || `client-${clientId}`,
      plan: subscription?.plan || 'starter',
    };

    const job = await deploymentQueue.addDeploymentJob(jobData);

    insertAuditLog('admin_provision_customer', { customerId: req.params.id, jobId: job.id }, req).catch(() => {});

    res.status(202).json({ jobId: job.id, message: 'Deployment job queued' });
  } catch (error) {
    logger.error('[admin] Failed to provision customer', { id: req.params.id, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to queue provisioning job' });
  }
});

/**
 * POST /api/admin/customers/:id/deprovision
 * Enqueue a delete-customer-stack job for a customer.
 */
router.post('/customers/:id/deprovision', async (req: Request, res: Response) => {
  try {
    const customer = await CustomerModel.getById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    if (!customer.instance_namespace) {
      return res.status(400).json({ error: 'Customer has no deployed namespace to deprovision' });
    }

    const jobData: DeleteJobData = {
      customerId: customer.customer_id,
      namespace: customer.instance_namespace,
    };

    const job = await deploymentQueue.addDeleteJob(jobData);

    insertAuditLog('admin_deprovision_customer', { customerId: req.params.id, namespace: customer.instance_namespace, jobId: job.id }, req).catch(() => {});

    res.status(202).json({ jobId: job.id, message: 'Deprovision job queued' });
  } catch (error) {
    logger.error('[admin] Failed to deprovision customer', { id: req.params.id, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'Failed to queue deprovision job' });
  }
});

export default router;
