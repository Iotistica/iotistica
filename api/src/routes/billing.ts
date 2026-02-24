/**
 * Billing Routes
 * Handle subscription upgrades and billing integration with Global Billing API
 */

import { Router, Request, Response } from 'express';
import { BillingClient } from '../services/billing-client';
import { LicenseValidator } from '../services/license-validator';
import { jwtAuth } from '../middleware/jwt-auth';

const router = Router();



/**
 * GET /api/billing/subscription
 * Get current subscription details
 * REQUIRES AUTHENTICATION
 */
router.get('/subscription', jwtAuth, async (req: Request, res: Response) => {
  try {
    const billingClient = BillingClient.getInstance();
    
    if (!billingClient.isConfigured()) {
      return res.status(503).json({
        error: 'Billing API not configured',
        message: 'Contact your administrator to configure BILLING_API_URL and CUSTOMER_ID',
      });
    }

    const license = LicenseValidator.getInstance();
    const licenseData = license.getLicense();
    
    // Get subscription from billing API
    const subscription = await billingClient.getSubscription();
    
    res.json({
      license: licenseData,
      subscription,
    });
  } catch (error: any) {
    console.error('Error fetching subscription:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/billing/upgrade
 * Create Stripe checkout session for plan upgrade
 * REQUIRES AUTHENTICATION
 */
router.post('/upgrade', jwtAuth, async (req: Request, res: Response) => {
  try {
    const { plan } = req.body;

    if (!plan || !['starter', 'professional', 'enterprise'].includes(plan)) {
      return res.status(400).json({ 
        error: 'Invalid plan. Choose: starter, professional, enterprise' 
      });
    }

    const billingClient = BillingClient.getInstance();
    
    if (!billingClient.isConfigured()) {
      return res.status(503).json({
        error: 'Billing API not configured',
        message: 'Contact your administrator to configure BILLING_API_URL and CUSTOMER_ID',
      });
    }

    // Create checkout session
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const checkoutSession = await billingClient.createCheckoutSession(
      plan,
      `${baseUrl}/api/billing/success`,
      `${baseUrl}/api/billing/cancel`
    );

    res.json({
      checkout_url: checkoutSession.checkout_url,
      session_id: checkoutSession.session_id,
    });
  } catch (error: any) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/billing/success
 * Redirect after successful payment
 * Validates session_id from checkout process
 */
router.get('/success', async (req: Request, res: Response) => {
  const { session_id } = req.query;
  
  if (!session_id || typeof session_id !== 'string') {
    return res.status(400).send(`
      <html>
        <head><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ Invalid Request</h1>
          <p>Missing or invalid session ID.</p>
          <a href="/" style="color: blue;">Return to Dashboard</a>
        </body>
      </html>
    `);
  }
  try {
    // Refresh license from billing API
    const billingClient = BillingClient.getInstance();
    await billingClient.refreshLicense();
    
    res.send(`
      <html>
        <head><title>Payment Successful</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: green;">✅ Payment Successful!</h1>
          <p>Your subscription has been upgraded.</p>
          <p>New features are now available.</p>
          <a href="/" style="color: blue;">Return to Dashboard</a>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error('Error refreshing license:', error);
    res.status(500).send(`
      <html>
        <head><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ Error</h1>
          <p>Payment was successful, but failed to refresh license.</p>
          <p>${error.message}</p>
          <a href="/" style="color: blue;">Return to Dashboard</a>
        </body>
      </html>
    `);
  }
});

/**
 * GET /api/billing/cancel
 * Redirect after cancelled payment
 * Validates session_id from checkout process
 */
router.get('/cancel', (req: Request, res: Response) => {
  const { session_id } = req.query;
  
  if (!session_id || typeof session_id !== 'string') {
    return res.status(400).send(`
      <html>
        <head><title>Error</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ Invalid Request</h1>
          <p>Missing or invalid session ID.</p>
          <a href="/" style="color: blue;">Return to Dashboard</a>
        </body>
      </html>
    `);
  }
  res.send(`
    <html>
      <head><title>Payment Cancelled</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1 style="color: orange;">⚠️ Payment Cancelled</h1>
        <p>You cancelled the payment process.</p>
        <p>Your subscription remains unchanged.</p>
        <a href="/api/billing/subscription" style="color: blue;">View Current Plan</a> | 
        <a href="/" style="color: blue;">Return to Dashboard</a>
      </body>
    </html>
  `);
});

/**
 * POST /api/billing/refresh-license
 * Manually refresh license from billing API
 * REQUIRES AUTHENTICATION
 */
router.post('/refresh-license', jwtAuth, async (req: Request, res: Response) => {
  try {
    const billingClient = BillingClient.getInstance();
    
    if (!billingClient.isConfigured()) {
      return res.status(503).json({
        error: 'Billing API not configured',
      });
    }

    const newLicense = await billingClient.refreshLicense();
    const license = LicenseValidator.getInstance();
    const licenseData = license.getLicense();
    
    res.json({
      message: 'License refreshed successfully',
      license: licenseData,
    });
  } catch (error: any) {
    console.error('Error refreshing license:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
