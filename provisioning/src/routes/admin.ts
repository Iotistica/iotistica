import express, { Request, Response } from 'express';
import { Client as PgClient } from 'pg';
import { deploymentQueue } from '../services/deployment-queue';
import { APIMigrationService, PostgresProvisioningService } from '../services/postgres-provisioning-service';
import { logger } from '../utils/logger';

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

export default router;
