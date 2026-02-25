/**
 * Customer Routes
 * Manage customers
 */

import { Router } from 'express';
import { CustomerModel } from '../db/customer-model';
import { SubscriptionModel } from '../db/subscription-model';
import { LicenseGenerator } from '../services/license-generator';
import { LicenseHistoryModel } from '../db/license-history-model';
import { k8sDeploymentService } from '../services/k8s-deployment-service';
import { deploymentQueue } from '../services/deployment-queue';
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

    // Determine priority based on plan (1=highest, 10=lowest)
    const priority = subscription.plan === 'enterprise' ? 1 : 
                     subscription.plan === 'professional' ? 2 : 
                     subscription.plan === 'starter' ? 3 : 5; // trial = 5

    const job = await deploymentQueue.addDeploymentJob({
      customerId: customer.customer_id,
      email,
      companyName: company_name,
      licenseKey: license,
      priority,
      metadata: {
        signupSource: 'self_service',
        plan: subscription.plan,
        trialDays: TRIAL_DAYS,
      },
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
      license: {
        jwt: license,
        expires_at: new Date(decoded.expiresAt * 1000).toISOString(),
        public_key: LicenseGenerator.getPublicKey(),
        features: decoded.features,
        limits: decoded.limits,
      },
      deployment: {
        status: 'queued',
        job_id: job.id,
        message: 'Your instance deployment is queued and will begin shortly',
        estimated_time: '2-5 minutes',
        instance_url: `https://${customer.customer_id}.${process.env.BASE_DOMAIN || 'iotistic.ca'}`,
        check_status_url: `/api/queue/jobs/${job.id}`,
      },
      next_steps: [
        'Save your license key (JWT) - you\'ll need it to configure your instance',
        'Download and deploy the Iotistic stack using the provided license',
        'Connect your first BME688 sensor',
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

    // Generate fresh license
    const license = await LicenseGenerator.generateLicense(customer, subscription);

    // Trigger deployment
    const result = await k8sDeploymentService.deployCustomerInstance({
      customerId: customer.customer_id,
      email: customer.email,
      companyName: customer.company_name || 'Unknown Company',
      licenseKey: license,
    });

    res.json(result);
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

    const status = await k8sDeploymentService.getDeploymentStatus(id);
    res.json(status);
  } catch (error: any) {
    console.error('Error getting deployment status:', error);
    res.status(500).json({ error: error.message });
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

    const result = await k8sDeploymentService.deleteCustomerInstance(id);
    res.json(result);
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
