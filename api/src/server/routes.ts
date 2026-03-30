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
import mqttBrokerRoutes from '../mqtt/broker';
import mqttMetricsRoutes from '../mqtt/metrics';
import { router as deviceSensorsRoutes } from '../routes/agent-devices';
import { router as trafficRoutes } from '../routes/traffic';
import { router as deviceTagsRoutes } from '../routes/agent-tags';
import dashboardLayoutsRoutes from '../routes/dashboard-layouts';
import mosquittoAuthRoutes from '../mqtt/auth';
import { router as noderedStorageRoutes } from '../routes/nodered';
import { router as metricsRoutes } from '../routes/metrics';
import prometheusRoutes from '../routes/prometheus';
import anomalyRoutes from '../routes/anomaly';
import anomalyIncidentsRoutes from '../routes/anomaly-incidents';
import anomalyAlertsRoutes from '../routes/anomaly-alerts';
import profileRoutes from '../routes/profiles';
import aiChatRoutes from '../routes/ai-chat';
import dashboardAiRoutes from '../routes/dashboard-ai';
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

// Fixed paths used in multiple places — centralised to avoid typos
const PATHS = {
  root:           '/',
  health:         '/health',
  metrics:        '/metrics',
  mosquittoAuth:  '/mosquitto-auth',
  // Sub-router relative paths (mounted under API_BASE)
  auth:               '/auth',
  users:              '/users',
  admin:              '/admin',
  profiles:           '/profiles',
  dashboardLayouts:   '/dashboard-layouts',
  dashboard:          '/dashboard',
  metricsCatalog:     '/metrics',
} as const;

export function mountRoutes(app: express.Application): void {
  // Root info endpoint
  app.get(PATHS.root, (req, res) => {
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
  app.get(PATHS.health, (req, res) => {
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
  app.use(PATHS.mosquittoAuth, mosquittoAuthRoutes);

  // ============================================================================
  // Versioned API sub-router — all routes below are relative to API_BASE
  // ============================================================================
  const api = express.Router();

  // Rate Limiting - applied first so it covers all versioned routes
  api.use(globalApiRateLimit);

  // Auth - strict rate limit (brute-force protection)
  api.use(PATHS.auth, authRateLimit, authRoutes);

  // CRITICAL: agentsRoutes BEFORE usersRoutes to prevent /:id matching /agents
  api.use(agentsRoutes);

  // User / admin management - JWT required
  api.use(PATHS.users, jwtAuth, adminRateLimit, usersRoutes);
  api.use(PATHS.admin, jwtAuth, adminRateLimit, adminRoutes);

  // Invites: accept is public (handled internally), other ops require jwtAuth
  api.use(invitesRoutes);

  // Device data ingestion - high rate limits (supports 16Hz sensor data)
  api.use(deviceDataRateLimit, deviceLogsRoutes);
  api.use(deviceDataRateLimit, deviceMetricsRoutes);
  api.use(deviceDataRateLimit, deviceSensorsRoutes);

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
  standardRoutes.forEach(r => api.use(r));

  // Fixed sub-path prefix routes (cannot use the forEach pattern above)
  api.use(PATHS.profiles, profileRoutes);
  api.use(PATHS.dashboardLayouts, dashboardLayoutsRoutes);
  api.use(PATHS.dashboard, dashboardAiRoutes);
  api.use(PATHS.metricsCatalog, metricsRoutes);

  // Mount the versioned sub-router once
  app.use(API_BASE, api);
}
