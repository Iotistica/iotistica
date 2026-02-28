/**
 * Customer Routes
 * Manage customers
 */

import { Router } from 'express';
import { CustomerModel } from '../db/customer-model';
import { SubscriptionModel } from '../db/subscription-model';
import { LicenseGenerator } from '../services/license-generator';
import { LicenseHistoryModel } from '../db/license-history-model';
import { deploymentQueue } from '../services/deployment-queue';
import { TigerDataService } from '../services/tigerdata-service';
import { OnePasswordService } from '../services/onepassword-service';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const router = Router();

/**
 * POST /api/customers/signup
 * Public endpoint - Customer self-signup with trial
 * 
 * This is the main entry point for new customer registration.
 * Creates customer account, trial subscription, license, and triggers deployment.
 * 
 * Body:
 * - email: Customer email (required)
 * - password: Password min 8 chars (required)
 * - company_name: Company name (required)
 * - full_name: Contact name (optional)
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, company_name, full_name } = req.body;

    // ========================================
    // Step 1: Validation
    // ========================================
    if (!email || !password || !company_name) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Email, password, and company name are required',
        required: ['email', 'password', 'company_name']
      });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        error: 'Invalid email format',
        message: 'Please provide a valid email address'
      });
    }

    // Password strength (min 8 chars, at least 1 uppercase, 1 lowercase, 1 number)
    if (password.length < 8) {
      return res.status(400).json({ 
        error: 'Password too weak',
        message: 'Password must be at least 8 characters',
        requirements: [
          'Minimum 8 characters',
          'At least 1 uppercase letter (recommended)',
          'At least 1 number (recommended)'
        ]
      });
    }

    // Check if customer already exists
    const existingCustomer = await CustomerModel.getByEmail(email);
    if (existingCustomer) {
      return res.status(409).json({ 
        error: 'Email already registered',
        message: 'An account with this email already exists. Please sign in or use a different email.'
      });
    }

    // ========================================
    // Step 2: Create customer with hashed password
    // ========================================
    const passwordHash = await bcrypt.hash(password, 10);
    
    const customer = await CustomerModel.create({
      email,
      companyName: company_name,
      fullName: full_name,
      passwordHash,
    });

    console.log(`👤 Customer created: ${email} (${customer.customer_id})`);

    // ========================================
    // Step 3: Create 14-day trial subscription
    // ========================================
    const TRIAL_DAYS = 14;
    const subscription = await SubscriptionModel.createTrial(
      customer.customer_id, 
      'starter',
      TRIAL_DAYS
    );

    console.log(`🎁 Trial subscription created: ${subscription.plan} (${TRIAL_DAYS} days)`);

    // ========================================
    // Step 4: Generate trial license JWT
    // ========================================
    const license = await LicenseGenerator.generateLicense(customer, subscription);
    const decoded = LicenseGenerator.verifyLicense(license);

    console.log(`🔑 License generated: ${decoded.features.maxDevices} devices max`);

    // ========================================
    // Step 5: Log audit trail
    // ========================================
    const licenseHash = crypto.createHash('sha256').update(license).digest('hex');
    await LicenseHistoryModel.log({
      customerId: customer.customer_id,
      action: 'generated',
      plan: subscription.plan,
      maxDevices: decoded.features.maxDevices,
      licenseHash,
      generatedBy: 'signup',
      metadata: {
        type: 'trial_signup',
        trialDays: TRIAL_DAYS,
        signupSource: 'self_service',
        features: decoded.features,
        limits: decoded.limits,
      }
    });

    // ========================================
    // Step 6: Queue Kubernetes deployment
    // ========================================
    // Add deployment job to queue (instant response, deployment happens in background)
    await CustomerModel.updateDeploymentStatus(customer.customer_id, 'pending');

    // Hash customer_id to get 12-char client ID (matches Stripe flow)
    const clientId = crypto
      .createHash('sha256')
      .update(customer.customer_id)
      .digest('hex')
      .substring(0, 12);
    
    const namespace = `client-${clientId}`;

    // License will be fetched by gitops-provisioning-service from provisioning API
    const job = await deploymentQueue.addDeploymentJob({
      customerId: customer.customer_id,
      email,
      companyName: company_name,
      namespace,
      plan: subscription.plan,
      domain: process.env.BASE_DOMAIN || 'iotistica.com',
    });

    console.log(`🚀 Deployment job queued: ${job.id} for customer ${customer.customer_id}`);

    // ========================================
    // Step 7: Send welcome email (TODO)
    // ========================================
    // await emailService.sendTrialWelcome({
    //   email,
    //   companyName: company_name,
    //   trialDays: TRIAL_DAYS,
    //   instanceUrl: `https://${customer.customer_id}.iotistic.cloud`,
    // });

    console.log(`✅ Customer signup complete: ${email} (${customer.customer_id})`);
    console.log(`   Trial expires: ${subscription.trial_ends_at}`);
    console.log(`   Max devices: ${decoded.features.maxDevices}`);
    console.log(`   Deployment job: ${job.id}`);

    // ========================================
    // Step 8: Return success response
    // ========================================
    res.status(201).json({
      message: 'Account created successfully! Your 14-day trial has started.',
      customer: {
        customer_id: customer.customer_id,
        email: customer.email,
        company_name: customer.company_name,
        full_name: customer.full_name,
      },
      subscription: {
        plan: subscription.plan,
        status: subscription.status,
        trial_ends_at: subscription.trial_ends_at,
        trial_days_remaining: Math.ceil(
          (new Date(subscription.trial_ends_at!).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        ),
      },
      deployment: {
        status: 'queued',
        job_id: job.id,
        namespace,
        message: 'Your instance deployment is queued and will begin shortly',
        estimated_time: '2-5 minutes',
        instance_url: `https://${namespace}.${process.env.BASE_DOMAIN || 'iotistica.com'}`,
        check_status_url: `/api/queue/jobs/${job.id}`,
      },
      next_steps: [
        'Your instance is being deployed and will be ready in 2-5 minutes',
        'You will receive an email with access instructions once deployment completes',
        'Connect your first BME688 sensor to start collecting data',
        `Your trial expires in ${TRIAL_DAYS} days - upgrade anytime to continue`,
      ]
    });

  } catch (error: any) {
    console.error('❌ Signup error:', error);
    res.status(500).json({ 
      error: 'Signup failed', 
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * POST /api/customers/login
 * Customer authentication
 * 
 * Body:
 * - email: Customer email
 * - password: Password
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        error: 'Missing credentials',
        message: 'Email and password are required'
      });
    }

    // Verify password
    const customer = await CustomerModel.verifyPassword(email, password);
    
    if (!customer) {
      return res.status(401).json({ 
        error: 'Invalid credentials',
        message: 'Email or password is incorrect'
      });
    }

    // Get subscription
    const subscription = await SubscriptionModel.getByCustomerId(customer.customer_id);

    // Generate fresh license
    const license = subscription 
      ? await LicenseGenerator.generateLicense(customer, subscription)
      : null;

    const decoded = license ? LicenseGenerator.verifyLicense(license) : null;

    console.log(`🔓 Customer login: ${email} (${customer.customer_id})`);

    res.json({
      message: 'Login successful',
      customer: {
        customer_id: customer.customer_id,
        email: customer.email,
        company_name: customer.company_name,
        full_name: customer.full_name,
      },
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        trial_ends_at: subscription.trial_ends_at,
        current_period_ends_at: subscription.current_period_ends_at,
      } : null,
      license: license && decoded ? {
        jwt: license,
        expires_at: new Date(decoded.expiresAt * 1000).toISOString(),
        features: decoded.features,
        limits: decoded.limits,
      } : null,
      deployment: {
        status: customer.deployment_status || 'pending',
        instance_url: customer.instance_url,
        deployed_at: customer.deployed_at,
      }
    });

  } catch (error: any) {
    console.error('❌ Login error:', error);
    res.status(500).json({ 
      error: 'Login failed', 
      message: error.message 
    });
  }
});

/**
 * POST /api/customers
 * Create new customer (admin/internal use)
 */
router.post('/', async (req, res) => {
  try {
    const { email, company_name } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if customer exists
    const existing = await CustomerModel.getByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Customer already exists' });
    }

    // Create customer
    const customer = await CustomerModel.create({ 
      email, 
      companyName: company_name 
    });

    // Create trial subscription
    const subscription = await SubscriptionModel.createTrial(
      customer.customer_id,
      'starter',
      14
    );

    // Generate license
    const license = await LicenseGenerator.generateLicense(customer, subscription);

    res.status(201).json({
      customer,
      subscription,
      license,
    });
  } catch (error: any) {
    console.error('Error creating customer:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/customers/:id
 * Get customer details
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await CustomerModel.getById(id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const subscription = await SubscriptionModel.getByCustomerId(id);

    res.json({
      customer,
      subscription,
    });
  } catch (error: any) {
    console.error('Error fetching customer:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/customers
 * List all customers
 */
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const customers = await CustomerModel.list(limit, offset);
    res.json({ customers, limit, offset });
  } catch (error: any) {
    console.error('Error listing customers:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/customers/:id
 * Update customer
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { company_name } = req.body;

    const customer = await CustomerModel.update(id, {
      company_name,
    });

    res.json({ customer });
  } catch (error: any) {
    console.error('Error updating customer:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/customers/:id/deploy
 * Manually trigger/retry deployment for a customer
 */
router.post('/:id/deploy', async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await CustomerModel.getById(id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get active subscription and license
    const subscription = await SubscriptionModel.getByCustomerId(id);
    if (!subscription) {
      return res.status(400).json({ 
        error: 'No active subscription',
        message: 'Customer must have an active subscription to deploy' 
      });
    }

    // Update deployment status
    await CustomerModel.updateDeploymentStatus(customer.customer_id, 'pending');

    // Hash customer_id to get 12-char client ID (matches Stripe flow)
    const clientId = crypto
      .createHash('sha256')
      .update(customer.customer_id)
      .digest('hex')
      .substring(0, 12);
    
    const namespace = `client-${clientId}`;

    // License will be fetched by gitops-provisioning-service from provisioning API
    const job = await deploymentQueue.addDeploymentJob({
      customerId: customer.customer_id,
      email: customer.email,
      companyName: customer.company_name || 'Unknown Company',
      namespace,
      plan: subscription.plan,
      domain: process.env.BASE_DOMAIN || 'iotistica.com',
    });

    console.log(`🚀 Deployment job queued: ${job.id} for customer ${customer.customer_id}`);

    res.json({
      message: 'Deployment job queued successfully',
      customerId: customer.customer_id,
      jobId: job.id,
      status: 'pending',
      check_status_url: `/api/queue/jobs/${job.id}`,
    });
  } catch (error: any) {
    console.error('Error triggering deployment:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/customers/:id/deployment/status
 * Get deployment status for a customer
 */
router.get('/:id/deployment/status', async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await CustomerModel.getById(id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({
      customerId: customer.customer_id,
      deployment_status: customer.deployment_status,
      instance_url: customer.instance_url,
      instance_namespace: customer.instance_namespace,
      deployed_at: customer.deployed_at,
      deployment_error: customer.deployment_error,
      last_provisioning_step: customer.last_provisioning_step,
      provisioning_started_at: customer.provisioning_started_at,
      provisioning_completed_at: customer.provisioning_completed_at,
      database: {
        service_id: customer.db_service_id,
        host: customer.db_host,
        port: customer.db_port,
        name: customer.db_name,
        provisioned_at: customer.db_provisioned_at,
      },
    });
  } catch (error: any) {
    console.error('Error getting deployment status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/customers/:id/retry-deployment
 * Retry a failed deployment
 * 
 * This is specifically designed for handling deployment failures:
 * - If TigerData DB already provisioned, skip DB provisioning step
 * - Reset Argo CD retry counter
 * - Re-enqueue deployment job with existing resources
 * 
 * Use cases:
 * - Argo CD sync failed (after 3 retries)
 * - 1Password secret creation failed
 * - Transient network errors during deployment
 */
router.post('/:id/retry-deployment', async (req, res) => {
  try {
    const { id } = req.params;

    console.log(`🔄 Deployment retry requested: ${id}`);

    const customer = await CustomerModel.getById(id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Check if deployment actually failed
    const failedStatuses = ['failed', 'deployment_failed'];
    if (!failedStatuses.includes(customer.deployment_status || '')) {
      return res.status(400).json({
        error: 'Deployment not in failed state',
        message: `Current status is '${customer.deployment_status}'. Retry is only available for failed deployments.`,
        currentStatus: customer.deployment_status,
      });
    }

    // Get subscription and regenerate license
    const subscription = await SubscriptionModel.getByCustomerId(id);
    if (!subscription) {
      return res.status(400).json({
        error: 'No active subscription',
        message: 'Customer must have an active subscription to retry deployment',
      });
    }

    console.log(`📝 Resetting deployment state for retry...`);

    // Reset deployment error and Argo retry count
    await CustomerModel.resetArgoRetry(id);
    
    // Determine starting status based on what's already provisioned
    let startingStatus = 'db_provisioning';
    if (customer.db_service_id) {
      console.log(`✅ TigerData DB already provisioned (${customer.db_service_id}), skipping DB step`);
      startingStatus = 'secret_ready'; // Start from Git commit step
    }

    // Update status to restart from appropriate step
    await CustomerModel.updateDeploymentStatus(id, startingStatus as any, {
      deploymentError: '', // Clear error message
    });

    // Hash customer_id to get 12-char client ID (matches Stripe flow)
    const clientId = crypto
      .createHash('sha256')
      .update(customer.customer_id)
      .digest('hex')
      .substring(0, 12);
    
    const namespace = customer.instance_namespace || `client-${clientId}`;

    // License will be fetched by gitops-provisioning-service from provisioning API
    const job = await deploymentQueue.addDeploymentJob({
      customerId: customer.customer_id,
      email: customer.email,
      companyName: customer.company_name || 'Unknown Company',
      namespace,
      plan: subscription.plan,
      domain: process.env.BASE_DOMAIN || 'iotistica.com',
    });

    console.log(`✅ Deployment retry queued: ${job.id}`);

    res.json({
      message: 'Deployment retry queued successfully',
      customerId: id,
      jobId: job.id,
      startingStatus,
      skipDatabase: !!customer.db_service_id,
      previousError: customer.deployment_error,
      note: customer.db_service_id
        ? 'Using existing TigerData database, will retry from secret creation onwards'
        : 'Will provision new TigerData database',
    });
  } catch (error: any) {
    console.error('Error retrying deployment:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/customers/:id/recover-database-password
 * Attempt to recover/reset TigerData database password
 * 
 * This endpoint tries to:
 * 1. Reset the password via TigerData API (if supported)
 * 2. Retrieve the password from TigerData API (if available)
 * 3. Update the 1Password secret with the new password
 * 
 * Note: Most database providers do not expose passwords after creation for security.
 * This endpoint attempts multiple recovery strategies but may require manual intervention.
 */
router.post('/:id/recover-database-password', async (req, res) => {
  const { id } = req.params;

  try {
    console.log(`🔑 Attempting password recovery for customer: ${id}`);

    // ========================================
    // Step 1: Validate customer and database existence
    // ========================================
    const customer = await CustomerModel.getById(id);
    if (!customer) {
      return res.status(404).json({ 
        error: 'Customer not found',
        customerId: id 
      });
    }

    if (!customer.db_service_id) {
      return res.status(400).json({
        error: 'No TigerData database provisioned',
        message: 'This customer does not have a TigerData database. Deploy the customer first.',
        customerId: id
      });
    }

    console.log(`📊 Customer: ${customer.email}`);
    console.log(`   Database Service ID: ${customer.db_service_id}`);
    console.log(`   1Password Secret: ${customer.secret_item_id || 'Not created yet'}`);

    // ========================================
    // Step 2: Initialize services
    // ========================================
    const tigerDataService = new TigerDataService();
    const onePasswordService = new OnePasswordService();

    let recoveredPassword: string | undefined;
    let recoveryMethod: string = 'unknown';

    // ========================================
    // Step 3: Try password reset (if API supports it)
    // ========================================
    try {
      console.log(`🔄 Attempting password reset via TigerData API...`);
      recoveredPassword = await tigerDataService.resetPassword(customer.db_service_id);
      recoveryMethod = 'api_reset';
      console.log(`✅ Password reset successful!`);
    } catch (resetError: any) {
      console.warn(`⚠️  Password reset failed:`, resetError.message);
      
      // ========================================
      // Step 4: Try password retrieval (if API supports it)
      // ========================================
      try {
        console.log(`🔍 Attempting password retrieval via TigerData API...`);
        const credentials = await tigerDataService.getCredentials(customer.db_service_id);
        if (credentials.password) {
          recoveredPassword = credentials.password;
          recoveryMethod = 'api_retrieve';
          console.log(`✅ Password retrieved successfully!`);
        }
      } catch (retrieveError: any) {
        console.warn(`⚠️  Password retrieval failed:`, retrieveError.message);
      }
    }

    // ========================================
    // Step 5: If password recovered, update 1Password secret
    // ========================================
    if (recoveredPassword) {
      if (customer.secret_item_id) {
        try {
          console.log(`📝 Updating 1Password secret: ${customer.secret_item_id}`);
          
          // Get existing secret to extract current values
          const existingSecret = await onePasswordService.getItem(customer.secret_item_id);
          
          // Extract current database credentials from fields
          const getFieldValue = (fieldId: string, defaultValue: string = ''): string => {
            const field = existingSecret.fields?.find(f => f.id === fieldId);
            return field?.value || defaultValue;
          };

          // Build updated credentials with new password
          const updatedCredentials = {
            host: customer.db_host || getFieldValue('server', 'localhost'),
            port: customer.db_port || parseInt(getFieldValue('port', '5432')),
            username: getFieldValue('username', 'tsdbadmin'),
            password: recoveredPassword,
            database: customer.db_name || getFieldValue('dbname', 'tsdb'),
          };

          // Update in 1Password
          await onePasswordService.updateItem(
            customer.secret_item_id,
            updatedCredentials
          );

          console.log(`✅ 1Password secret updated successfully`);

          return res.json({
            success: true,
            message: 'Database password recovered and updated in 1Password',
            customerId: id,
            serviceId: customer.db_service_id,
            secretId: customer.secret_item_id,
            recoveryMethod,
            password: process.env.SHOW_PASSWORDS_IN_API === 'true' ? recoveredPassword : '[redacted]',
            note: 'Password has been updated in 1Password. Use the secret ID to retrieve it securely.',
          });
        } catch (onePasswordError: any) {
          console.error(`❌ Failed to update 1Password secret:`, onePasswordError.message);
          
          return res.json({
            success: true,
            warning: 'Password recovered but failed to update 1Password',
            message: 'Database password was recovered from TigerData but could not be saved to 1Password',
            customerId: id,
            serviceId: customer.db_service_id,
            recoveryMethod,
            password: recoveredPassword, // Return password since we can't store it
            error: onePasswordError.message,
            action: 'Please save this password manually in 1Password',
          });
        }
      } else {
        // No 1Password secret exists yet
        return res.json({
          success: true,
          warning: 'No 1Password secret exists',
          message: 'Password recovered but customer has no 1Password secret to update',
          customerId: id,
          serviceId: customer.db_service_id,
          recoveryMethod,
          password: recoveredPassword, // Return password since we can't store it
          action: 'Create 1Password secret or save password manually',
        });
      }
    }

    // ========================================
    // Step 6: Recovery failed - provide manual instructions
    // ========================================
    return res.status(422).json({
      success: false,
      error: 'Automatic password recovery not supported',
      message: 'TigerData API does not support password reset or retrieval after database creation',
      customerId: id,
      serviceId: customer.db_service_id,
      manualRecovery: {
        steps: [
          '1. Log in to TigerData console: https://console.cloud.timescale.com',
          '2. Navigate to your project and find the database service',
          '3. Look for password reset or credentials option',
          '4. Copy the password and update it in 1Password manually',
          `5. Update the secret: ${customer.secret_item_id || 'Create a new secret first'}`,
        ],
        alternativeApproach: [
          'If password cannot be recovered:',
          '1. Delete the existing database via TigerData console',
          '2. Use POST /api/customers/:id/retry-deployment to provision a new database',
          '3. The new database will have a fresh password saved automatically',
        ],
      },
      databaseInfo: {
        serviceId: customer.db_service_id,
        host: customer.db_host,
        port: customer.db_port,
        username: 'tsdbadmin', // TigerData default username
        dbName: customer.db_name || 'tsdb',
      },
    });
  } catch (error: any) {
    console.error('Error recovering database password:', error);
    res.status(500).json({ 
      error: error.message,
      customerId: id,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

/**
 * DELETE /api/customers/:id/deployment
 * Delete customer instance from Kubernetes
 */
router.delete('/:id/deployment', async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await CustomerModel.getById(id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Ensure customer has a namespace to delete
    if (!customer.instance_namespace) {
      return res.status(400).json({ 
        error: 'No deployment found',
        message: 'Customer has no Kubernetes namespace to delete'
      });
    }

    // Queue deletion job
    const job = await deploymentQueue.addDeleteJob({
      customerId: id,
      namespace: customer.instance_namespace
    });

    console.log(`🗑️  Deletion job queued: ${job.id} for namespace ${customer.instance_namespace}`);

    res.json({
      message: 'Deployment deletion queued successfully',
      customerId: id,
      namespace: customer.instance_namespace,
      jobId: job.id,
      check_status_url: `/api/queue/jobs/${job.id}`,
    });
  } catch (error: any) {
    console.error('Error deleting deployment:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/customers/:id
 * Delete customer account and all resources
 * 
 * This endpoint:
 * 1. Marks customer as deleted in database
 * 2. Queues a job to delete Kubernetes namespace
 * 3. Returns immediately (deletion happens asynchronously)
 * 
 * Use case: Customer cancellation, account termination, cleanup
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    console.log(`🗑️  Customer deletion requested: ${id}`);

    // Get customer record
    const customer = await CustomerModel.getById(id);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Check if already being deleted
    if (customer.deployment_status === 'pending' && !customer.instance_namespace) {
      return res.status(400).json({ 
        error: 'Customer deletion already in progress',
        customerId: id
      });
    }

    // Queue deletion job (asynchronous processing)
    const job = await deploymentQueue.addDeleteJob({
      customerId: id,
      namespace: customer.instance_namespace || ''
    });

    console.log(`✅ Deletion job queued: ${job.id}`);

    res.json({
      message: 'Customer deletion queued successfully',
      customerId: id,
      jobId: job.id,
      status: 'pending',
      note: 'Kubernetes namespace will be deleted asynchronously. Check job status for progress.'
    });

  } catch (error: any) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
