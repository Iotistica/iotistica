/**
 * Billing Server
 * Global billing system with Stripe integration and JWT license generation
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { testConnection } from './db/connection';
import { LicenseGenerator } from './services/license-generator';
import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { ExpressAdapter } from '@bull-board/express';

// Routes
import customersRouter from './routes/customers';
import subscriptionsRouter from './routes/subscriptions';
import licensesRouter from './routes/licenses';
import usageRouter from './routes/usage';
import webhooksRouter from './routes/webhooks';
import queueRouter from './routes/queue';
import upgradesRouter from './routes/upgrades';
import adminRouter from './routes/admin';
import authRouter from './routes/auth';
import internalRbacRouter from './routes/internal-rbac';

// Middleware
import { authenticateAdmin } from './middleware/auth';
import { apiLimiter, strictLimiter } from './middleware/rate-limit';

// Services
import { deploymentQueue } from './services/deployment-queue';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3100;

// Middleware
// Security headers with Helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding resources from other origins
}));
app.use(cors());

// Serve static website files from the website directory
// This allows /success.html and other website pages to be accessible
const websiteDir = path.join(__dirname, '..', '..', 'website');
app.use(express.static(websiteDir, { 
  setHeaders: (res, filePath) => {
    // Don't cache HTML files (they change)
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// IMPORTANT: Stripe webhooks need raw body, other routes need JSON
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

// Bull Board UI - Queue monitoring dashboard
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [
    new BullAdapter(deploymentQueue.getQueue())
  ],
  serverAdapter: serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'billing',
    timestamp: new Date().toISOString(),
  });
});

// API routes with security
// Public routes (rate limited, no auth)
app.use('/api/auth', apiLimiter, authRouter);  // Auth0 token validation
app.use('/api/webhooks', webhooksRouter);  // Stripe webhooks (signature verified internally)
app.use('/api/customers', apiLimiter, customersRouter);  // Signup is public, other routes handle auth internally

// Customer-authenticated routes (rate limited)
app.use('/api/subscriptions', apiLimiter, subscriptionsRouter);
app.use('/api/licenses', apiLimiter, licensesRouter);
app.use('/api/usage', apiLimiter, usageRouter);
app.use('/api/upgrades', apiLimiter, upgradesRouter);

// Admin-only routes (protected)
app.use('/api/admin', authenticateAdmin, adminRouter);
app.use('/api/queue', authenticateAdmin, queueRouter);

// Internal routes (protected by internal token)
app.use('/api/internal', internalRbacRouter);  // Has its own verifyInternalToken middleware

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize and start server
async function start() {
  try {
    console.log('🚀 Starting Provisioning...');

    // Test database connection
    await testConnection();
    console.log('✅ Database connected');

    // Initialize license generator (load RSA keys)
    LicenseGenerator.init();
    console.log('✅ License generator initialized');

    // Start server
    app.listen(PORT, () => {
      console.log(`✅ Provisioning API listening on port ${PORT}`);
      console.log(`   Health: http://localhost:${PORT}/health`);
      console.log(`   API: http://localhost:${PORT}/api`);
      console.log(`   Queue Dashboard: http://localhost:${PORT}/admin/queues`);
      console.log('');
      console.log('ℹ️  Note: Deployment worker runs in separate container');
      console.log('   Start with: npm run worker (or docker-compose up worker)');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT received, shutting down gracefully...');
  process.exit(0);
});

start();
