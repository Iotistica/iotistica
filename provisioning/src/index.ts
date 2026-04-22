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
import internalInvitesRouter from './routes/internal-invites';

// Middleware
import { authenticateAdmin } from './middleware/auth';
import { logger } from './utils/logger';
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

// Trust proxy - Required for rate limiting when behind a load balancer/reverse proxy (AKS ingress)
// This allows express-rate-limit to correctly identify client IPs from X-Forwarded-For header
app.set('trust proxy', 1);

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

// Admin UI SPA - serves the React admin interface
const adminUiDir = path.join(__dirname, '..', 'admin-ui', 'dist');
app.use('/admin', express.static(adminUiDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));
// SPA fallback: any unmatched /admin/* path returns index.html
app.get('/admin/*', (_req, res) => {
  res.sendFile(path.join(adminUiDir, 'index.html'));
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const redisStatus = await deploymentQueue.getRedisStatus();
    res.json({
      status: 'healthy',
      service: 'billing',
      timestamp: new Date().toISOString(),
      redis: redisStatus,
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      service: 'billing',
      timestamp: new Date().toISOString(),
      redis: { error: (error as any).message },
    });
  }
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
app.use('/api/internal', internalRbacRouter);      // Has its own verifyInternalToken middleware
app.use('/api/internal', internalInvitesRouter);   // Invite management (same protection)

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: any, req: any, res: any, next: any) => {
  logger.error('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize and start server
async function start() {
  try {
    logger.info('Starting Provisioning...');

    // Test database connection
    await testConnection();
    logger.info('Database connected');

    // Initialize license generator (load RSA keys)
    LicenseGenerator.init();
    logger.info('License generator initialized');

    // Start server
    app.listen(PORT, () => {
      logger.info(`Provisioning API listening on port ${PORT}`);
      logger.info(`Health: http://localhost:${PORT}/health`);
      logger.info(`API: http://localhost:${PORT}/api`);
      logger.info(`Queue Dashboard: http://localhost:${PORT}/admin/queues`);
      logger.info('Note: Deployment worker runs in separate container. Start with: npm run worker');
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

start();
