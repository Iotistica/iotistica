/**
 * Route mounting for the Iotistic API.
 *
 * Route ordering is intentional - see inline comments.
 * API_BASE is derived once here and re-exported for proxies.ts.
 */

import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { areApiDocsEnabled, setupApiDocs } from '../docs';

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
import deviceJobsRoutes from '../routes/agent-jobs';
import rotationRoutes from '../routes/rotation';
import eventsRoutes from '../routes/events';
import mqttBrokerRoutes from '../mqtt/broker';
import mqttMetricsRoutes from '../mqtt/metrics';
import deviceSensorsRoutes from '../routes/agent-devices';
import deviceTagsRoutes from '../routes/agent-tags';
import dashboardLayoutsRoutes from '../routes/dashboard-layouts';
import mosquittoAuthRoutes from '../mqtt/auth';
import noderedStorageRoutes from '../routes/nodered';
import metricsRoutes from '../routes/metrics';
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
import readingsRoutes from '../routes/readings';

import {
  globalRateLimitOptions,
  authRateLimitOptions,
  deviceDataRateLimitOptions,
  adminRateLimitOptions,
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
  readings:           '/readings',
  anomaly:            '/anomaly',
} as const;

export async function mountRoutes(fastify: FastifyInstance): Promise<void> {
  const apiDocsEnabled = areApiDocsEnabled();

  // Root info endpoint
  fastify.get(PATHS.root, async (_request, reply) => {
    return reply.send({
      status: 'ok',
      service: 'Iotistica API',
      version: '2.0.0',
      apiVersion: API_VERSION,
      apiBase: API_BASE,
      documentation: apiDocsEnabled ? '/api/docs' : undefined,
    });
  });

  // Health check (Kubernetes liveness/readiness probes)
  fastify.get(PATHS.health, async (_request, reply) => {
    return reply.status(200).send({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // API documentation (Swagger/OpenAPI)
  await setupApiDocs(fastify, API_BASE);

  // Prometheus scrape endpoint (no auth, standard /metrics path)
  await fastify.register(prometheusRoutes);

  // Mosquitto HTTP auth backend (no versioning - called directly by mosquitto-go-auth)
  await fastify.register(mosquittoAuthRoutes, { prefix: PATHS.mosquittoAuth });

  // ============================================================================
  // Versioned API scope — all routes below are relative to API_BASE
  // ============================================================================
  await fastify.register(async function apiBase(f) {
    // Global rate limit — covers all versioned routes
    await f.register(rateLimit, globalRateLimitOptions);

    // Auth — strict rate limit (brute-force protection)
    await f.register(async function authScope(af) {
      await af.register(rateLimit, authRateLimitOptions);
      await af.register(authRoutes);
    }, { prefix: PATHS.auth });

    // CRITICAL: agentsRoutes BEFORE usersRoutes to prevent /:id matching /agents
    await f.register(agentsRoutes);

    // User / admin management — JWT required + admin rate limit
    await f.register(async function adminScope(af) {
      await af.register(rateLimit, adminRateLimitOptions);
      await af.register(usersRoutes, { prefix: PATHS.users });
      await af.register(adminRoutes, { prefix: PATHS.admin });
    });

    // Invites: accept is public (handled internally), other ops require jwtAuth
    await f.register(invitesRoutes);

    // Device data ingestion — high rate limits (supports 16Hz sensor data)
    await f.register(async function deviceDataScope(df) {
      await df.register(rateLimit, deviceDataRateLimitOptions);
      await df.register(deviceLogsRoutes);
      await df.register(deviceMetricsRoutes);
      await df.register(deviceSensorsRoutes);
    });

    // Standard API routes (global rate limit already applied at apiBase scope)
    // ORDERING NOTE:
    //   - noderedStorageRoutes: before any pathless jwtAuth middleware
    //   - fleet/anomaly/incidents/alerts: MUST be before profileRoutes (/:name catches everything)
    const standardRoutes = [
      licenseRoutes,
      billingRoutes,
      provisioningRoutes,
      deviceStateRoutes,
      deviceJobsRoutes,
      rotationRoutes,
      noderedStorageRoutes,   // IMPORTANT: before pathless jwtAuth routers
      fleetRoutes,            // MUST be before profileRoutes
      anomalyIncidentsRoutes, // MUST be before profileRoutes
      anomalyAlertsRoutes,    // MUST be before profileRoutes
      mqttMetricsRoutes,
      eventsRoutes,
      mqttBrokerRoutes,
      deviceTagsRoutes,
      aiChatRoutes,
    ];
    for (const route of standardRoutes) {
      await f.register(route);
    }

    // Fixed sub-path prefix routes
    await f.register(profileRoutes, { prefix: PATHS.profiles });
    await f.register(dashboardLayoutsRoutes, { prefix: PATHS.dashboardLayouts });
    await f.register(dashboardAiRoutes, { prefix: PATHS.dashboard });
    await f.register(metricsRoutes, { prefix: PATHS.metricsCatalog });
    await f.register(readingsRoutes, { prefix: PATHS.readings });
    await f.register(anomalyRoutes, { prefix: PATHS.anomaly });

  }, { prefix: API_BASE });
}
