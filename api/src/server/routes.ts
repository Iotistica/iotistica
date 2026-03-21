/**
 * Route mounting for the Iotistic API.
 *
 * Route ordering is intentional - see inline comments.
 * API_BASE is derived once here and re-exported for proxies.ts.
 */

import express from 'express';
import { setupApiDocs } from '../docs';

// Route modules
import authRoutes from '../routes/auth';
import usersRoutes from '../routes/users';
import invitesRoutes from '../routes/invites';
import deviceStateRoutes from '../routes/agent-state';
import deviceLogsRoutes from '../routes/agent-logs';
import deviceMetricsRoutes from '../routes/agent-metrics';
import provisioningRoutes from '../routes/provisioning';
import agentsRoutes from '../routes/agents';
import adminRoutes from '../routes/admin';
import appsRoutes from '../routes/apps';
import imageRegistryRoutes from '../routes/image-registry';
import deviceJobsRoutes from '../routes/agent-jobs';
import rotationRoutes from '../routes/rotation';
import eventsRoutes from '../routes/events';
import mqttBrokerRoutes from '../mqtt/mqtt-broker';
import mqttMetricsRoutes from '../mqtt/mqtt-metrics';
import { router as deviceSensorsRoutes } from '../routes/agent-devices';
import { router as trafficRoutes } from '../routes/traffic';
import { router as deviceTagsRoutes } from '../routes/agent-tags';
import dashboardLayoutsRoutes from '../routes/dashboard-layouts';
import mosquittoAuthRoutes from '../mqtt/mqtt-auth';
import { router as noderedStorageRoutes } from '../routes/nodered-storage';
import { router as metricsCatalogRoutes } from '../routes/metrics-catalog';
import prometheusRoutes from '../routes/prometheus';
import anomalyRoutes from '../routes/anomaly';
import anomalyIncidentsRoutes from '../routes/anomaly-incidents';
import anomalyAlertsRoutes from '../routes/anomaly-alerts';
import profileRoutes from '../routes/profiles';
import aiChatRoutes from '../routes/ai-chat';
import licenseRoutes from '../routes/license';
import billingRoutes from '../routes/billing';
import fleetRoutes from '../routes/fleets';

import {
  globalApiRateLimit,
  authRateLimit,
  deviceDataRateLimit,
  adminRateLimit,
} from '../middleware/rate-limit';
import jwtAuth from '../middleware/jwt-auth';

export const API_VERSION = process.env.API_VERSION || 'v1';
export const API_BASE = `/api/${API_VERSION}`;

export function mountRoutes(app: express.Application): void {
  // Root info endpoint
  app.get('/', (req, res) => {
    res.json({
      status: 'ok',
      service: 'Iotistica API',
      version: '2.0.0',
      apiVersion: API_VERSION,
      apiBase: API_BASE,
      documentation: '/api/docs',
    });
  });

  // Health check (Kubernetes liveness/readiness probes)
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // API documentation (Swagger/OpenAPI)
  setupApiDocs(app, API_BASE);

  // Prometheus scrape endpoint (no auth, standard /metrics path)
  app.use(prometheusRoutes);

  // Mosquitto HTTP auth backend (no versioning - called directly by mosquitto-go-auth)
  app.use('/mosquitto-auth', mosquittoAuthRoutes);

  // ============================================================================
  // Rate Limiting - applied at API_BASE before all versioned routes
  // ============================================================================
  app.use(API_BASE, globalApiRateLimit);

  // ============================================================================
  // API Routes
  // ============================================================================

  // Auth - strict rate limit (brute-force protection)
  app.use(`${API_BASE}/auth`, authRateLimit, authRoutes);

  // CRITICAL: agentsRoutes BEFORE usersRoutes to prevent /:id matching /agents
  app.use(API_BASE, agentsRoutes);

  // User / admin management - JWT required
  app.use(`${API_BASE}/users`, jwtAuth, adminRateLimit, usersRoutes);
  app.use(`${API_BASE}/admin`, jwtAuth, adminRateLimit, adminRoutes);

  // Invites: accept is public (handled internally), other ops require jwtAuth
  app.use(API_BASE, invitesRoutes);

  // Device data ingestion - high rate limits (supports 16Hz sensor data)
  app.use(API_BASE, deviceDataRateLimit, deviceLogsRoutes);
  app.use(API_BASE, deviceDataRateLimit, deviceMetricsRoutes);
  app.use(API_BASE, deviceDataRateLimit, deviceSensorsRoutes);

  // Standard API routes - global rate limit already applied above
  // ORDERING NOTE:
  //   - noderedStorageRoutes: before any pathless jwtAuth middleware
  //   - fleet/anomaly/incidents/alerts: MUST be before profileRoutes (/:name catches everything)
  const standardRoutes = [
    licenseRoutes,
    billingRoutes,
    provisioningRoutes,
    appsRoutes,
    deviceStateRoutes,
    imageRegistryRoutes,
    deviceJobsRoutes,
    rotationRoutes,
    noderedStorageRoutes,   // IMPORTANT: before pathless jwtAuth routers
    fleetRoutes,            // MUST be before profileRoutes
    anomalyRoutes,          // MUST be before profileRoutes
    anomalyIncidentsRoutes, // MUST be before profileRoutes
    anomalyAlertsRoutes,    // MUST be before profileRoutes
    mqttMetricsRoutes,
    eventsRoutes,
    mqttBrokerRoutes,
    trafficRoutes,
    deviceTagsRoutes,
    aiChatRoutes,
  ];
  standardRoutes.forEach(r => app.use(API_BASE, r));

  // Fixed sub-path prefix routes (cannot use the forEach pattern above)
  app.use(`${API_BASE}/profiles`, profileRoutes);
  app.use(`${API_BASE}/dashboard-layouts`, dashboardLayoutsRoutes);
  app.use(`${API_BASE}/metrics`, metricsCatalogRoutes);
}
