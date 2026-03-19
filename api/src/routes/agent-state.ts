/**
 * Device State Management Routes
 * Handles device target state, current state, and state reporting
 * 
 * Separated from cloud.ts for better organization
 * 
 * Device-Side Endpoints (used by devices themselves):
 * - GET  /api/v1/device/:uuid/state - Device polls for target state (ETag cached)
 * - POST /api/v1/device/:uuid/logs - Device uploads logs
 * - PATCH /api/v1/device/state - Device reports current state + metrics
 * 
 * Management API Endpoints (used by dashboard/admin):
 * - GET /api/v1/devices/:uuid/target-state - Get device target state
 * - POST /api/v1/devices/:uuid/target-state - Set device target state
 * - PUT /api/v1/devices/:uuid/target-state - Update device target state
 * - GET /api/v1/devices/:uuid/current-state - Get device current state
 * - DELETE /api/v1/devices/:uuid/target-state - Clear device target state
 * - GET /api/v1/devices/:uuid/logs - Get device logs
 * - GET /api/v1/devices/:uuid/metrics - Get device metrics
 */

import express from 'express';
import bcrypt from 'bcrypt';
import {
  DeviceModel,
  DeviceTargetStateModel,
  DeviceCurrentStateModel,
  DeviceMetricsModel,
  DeviceLogsModel,
} from '../db/models';
import { validateTargetStateConfigMiddleware } from '../validators/target-state-config.validator';
import { EventPublisher, objectsAreEqual } from '../services/event-sourcing';
import EventSourcingConfig from '../events/event-sourcing';
import deviceAuth, { deviceAuthFromBody } from '../middleware/device-auth';
import { resolveAppsImages } from '../services/docker-registry';
import { deviceSensorSync } from '../services/agent-devices';
import { processAgentStateReport } from '../services/agent-state';
import logger from '../utils/logger';

export const router = express.Router();

// Initialize event publisher for audit trail
const eventPublisher = new EventPublisher();

async function applyPendingMqttAuth(config: any): Promise<any> {
  if (!config || typeof config !== 'object') {
    return config;
  }

  const nextConfig = JSON.parse(JSON.stringify(config));
  const endpoints = Array.isArray(nextConfig.endpoints) ? nextConfig.endpoints : [];

  for (const endpoint of endpoints) {
    if (endpoint?.protocol !== 'mqtt') {
      continue;
    }

    const mqttAuth = endpoint?.auth?.mqtt || endpoint?.metadata?.mqttAuth;
    if (!mqttAuth) {
      continue;
    }

    const username = typeof mqttAuth.username === 'string' ? mqttAuth.username.trim() : '';
    const password = typeof mqttAuth.password === 'string' ? mqttAuth.password : '';
    const existingHash = typeof mqttAuth.passwordHash === 'string' ? mqttAuth.passwordHash : '';
    const existingAlgo = typeof mqttAuth.hashAlgo === 'string' ? mqttAuth.hashAlgo : '';
    const access = Number.isInteger(mqttAuth.access) ? mqttAuth.access : 2;
    const topic = endpoint?.connection?.topic;

    if (!username) {
      throw new Error(`MQTT auth is missing username for endpoint ${endpoint?.name || 'unknown'}`);
    }

    if (!topic || typeof topic !== 'string') {
      throw new Error(`MQTT topic is missing for endpoint ${endpoint?.name || 'unknown'}`);
    }

    if (![1, 2, 3].includes(access)) {
      throw new Error(`MQTT access must be 1, 2, or 3 for endpoint ${endpoint?.name || 'unknown'}`);
    }

    let passwordHash = existingHash;
    let hashAlgo = existingAlgo;
    let hashParams: any = mqttAuth.hashParams && typeof mqttAuth.hashParams === 'object'
      ? mqttAuth.hashParams
      : undefined;

    if (password) {
      const bcryptCost = 12;
      passwordHash = await bcrypt.hash(password, bcryptCost);
      hashAlgo = 'bcrypt';
      hashParams = { cost: bcryptCost };
    }

    if (!passwordHash || !hashAlgo) {
      throw new Error(`MQTT auth is missing password or passwordHash for endpoint ${endpoint?.name || 'unknown'}`);
    }

    endpoint.connection = {
      ...(endpoint.connection || {}),
      username,
    };

    endpoint.auth = {
      ...(endpoint.auth || {}),
      mqtt: {
        username,
        passwordHash,
        hashAlgo,
        hashParams,
        access,
      },
    };

    if (endpoint.metadata && typeof endpoint.metadata === 'object' && endpoint.metadata.mqttAuth) {
      delete endpoint.metadata.mqttAuth;
      if (Object.keys(endpoint.metadata).length === 0) {
        delete endpoint.metadata;
      }
    }
  }

  return nextConfig;
}

function sanitizeAnomalyExpectedRanges(config: any): any {
  if (!config || typeof config !== 'object') {
    return config;
  }

  const nextConfig = JSON.parse(JSON.stringify(config));
  const metrics = nextConfig?.anomalyDetection?.metrics;
  if (!Array.isArray(metrics)) {
    return nextConfig;
  }

  for (const metric of metrics) {
    if (!metric || !Array.isArray(metric.expectedRange) || metric.expectedRange.length !== 2) {
      continue;
    }

    const [min, max] = metric.expectedRange;
    const validMin = typeof min === 'number' && Number.isFinite(min);
    const validMax = typeof max === 'number' && Number.isFinite(max);

    // Keep expectedRange only when both bounds are finite numbers.
    if (!validMin || !validMax) {
      delete metric.expectedRange;
    }
  }

  return nextConfig;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const SYSTEM_METRIC_NAMES = new Set([
  'cpu_usage',
  'cpu_temp',
  'cpu_cores',
  'memory_usage',
  'memory_total',
  'memory_percent',
  'storage_usage',
  'storage_total',
  'storage_percent',
  'uptime',
]);

function normalizeAnomalyMetricNames(config: any, deviceUuid: string): any {
  if (!config || typeof config !== 'object') {
    return config;
  }

  const nextConfig = JSON.parse(JSON.stringify(config));
  const metrics = nextConfig?.anomalyDetection?.metrics;
  if (!Array.isArray(metrics)) {
    return nextConfig;
  }

  // Build endpoint name → UUID map from config.endpoints so dashboard-submitted
  // metrics with { name: 'vibration', deviceName: 'opcua-1' } can be canonicalized
  // to <deviceUuid>_<endpointUuid>_vibration without a separate DB lookup.
  const endpointNameToUuid: Record<string, string> = {};
  const configEndpoints = Array.isArray(nextConfig.endpoints) ? nextConfig.endpoints : [];
  for (const ep of configEndpoints) {
    if (ep.name && ep.uuid) {
      endpointNameToUuid[ep.name] = ep.uuid;
    }
  }

  const deduped: any[] = [];
  const seenNames = new Set<string>();
  let droppedInvalidCount = 0;

  for (const metric of metrics) {
    if (!metric || typeof metric !== 'object') {
      continue;
    }

    const rawMetricName = typeof metric.name === 'string' ? metric.name.trim() : '';
    if (!rawMetricName) {
      continue;
    }

    let normalizedName = rawMetricName;

    // Canonical system naming: <deviceUuid>_system_<metricName>
    if (SYSTEM_METRIC_NAMES.has(rawMetricName)) {
      normalizedName = `${deviceUuid}_system_${rawMetricName}`;
    } else if (metric.deviceName && endpointNameToUuid[metric.deviceName]) {
      // Canonical endpoint naming: <deviceUuid>_<endpointUuid>_<metricName>
      // Auto-canonicalize dashboard-submitted metrics that carry deviceName (endpoint display name)
      // rather than a pre-built canonical key.
      normalizedName = `${deviceUuid}_${endpointNameToUuid[metric.deviceName]}_${rawMetricName}`;
    }

    const firstSep = normalizedName.indexOf('_');
    const secondSep = firstSep >= 0 ? normalizedName.indexOf('_', firstSep + 1) : -1;
    const metricDeviceUuid = firstSep > 0 ? normalizedName.slice(0, firstSep) : '';
    const scope = secondSep > firstSep ? normalizedName.slice(firstSep + 1, secondSep) : '';
    const metricField = secondSep > firstSep ? normalizedName.slice(secondSep + 1) : '';

    const isCanonicalSystem = (
      metricDeviceUuid === deviceUuid
      && scope === 'system'
      && SYSTEM_METRIC_NAMES.has(metricField)
    );

    const isCanonicalEndpoint = (
      metricDeviceUuid === deviceUuid
      && isUuid(scope)
      && metricField.trim().length > 0
    );

    if (!isCanonicalSystem && !isCanonicalEndpoint) {
      droppedInvalidCount += 1;
      continue;
    }

    const metricCopy: any = { ...metric };
    metricCopy.name = normalizedName;
    delete metricCopy.deviceName;

    if (seenNames.has(metricCopy.name)) {
      continue;
    }

    seenNames.add(metricCopy.name);
    deduped.push(metricCopy);
  }

  if (droppedInvalidCount > 0) {
    logger.warn('Dropped non-canonical anomaly metric entries', {
      deviceUuid,
      droppedCount: droppedInvalidCount,
      requiredFormat: '<deviceUuid>_<endpointUuid>_<metricName>',
    });
  }

  nextConfig.anomalyDetection.metrics = deduped;
  return nextConfig;
}

// ============================================================================
// Device State Endpoints (Device-Side - Used by devices themselves)
// ============================================================================

/**
 * Device polling for target state
 * GET /api/v1/device/:uuid/state
 * 
 * Supports ETag caching - returns 304 if state hasn't changed
 */
router.get('/device/:uuid/state', deviceAuth, async (req, res) => {
  try {
    const { uuid } = req.params;
    const ifNoneMatch = req.headers['if-none-match'];

    // Check if device exists (don't auto-create)
    const device = await DeviceModel.getOrCreate(uuid);
    if (!device) {
      logger.warn('Device not registered - rejecting state poll', {
        deviceUuid: uuid.substring(0, 8) + '...',
      });
      return res.status(404).json({
        error: 'Device not registered',
        message: 'Please complete device registration before polling state'
      });
    }

    // Get target state
    const targetState = await DeviceTargetStateModel.get(uuid);

    logger.debug('Device polling for target state', { 
      deviceId: uuid.substring(0, 8),
      hasTargetState: !!targetState
    });
    
    if (!targetState) {
      // No target state yet - return empty state
      logger.debug('No target state found - returning empty', { deviceId: uuid.substring(0, 8) });
      const emptyState = { [uuid]: { apps: {}, config: {} } };
      const etag = Buffer.from(JSON.stringify(emptyState))
        .toString('base64')
        .substring(0, 32);
      return res.set('ETag', etag).json(emptyState);
    }

    // Generate ETag
    const etag = DeviceTargetStateModel.generateETag(targetState);
    
    logger.debug('Target state details', {
      deviceId: uuid.substring(0, 8),
      version: targetState.version,
      updatedAt: targetState.updated_at,
      generatedETag: etag,
      clientETag: ifNoneMatch || 'none',
      appCount: Object.keys(targetState.apps || {}).length,
      needsDeployment: targetState.needs_deployment || false
    });

    // Prepare response payload (we'll use this for both 200 and 304 size tracking)
    const response = {
      [uuid]: {
        apps: typeof targetState.apps === 'string' 
          ? JSON.parse(targetState.apps as any) 
          : targetState.apps,
        config: typeof targetState.config === 'string'
          ? JSON.parse(targetState.config as any)
          : targetState.config || {},
        version: targetState.version,
        needs_deployment: targetState.needs_deployment || false,
        last_deployed_at: targetState.last_deployed_at || null
      }
    };

    // Debug: Log what we're sending to the agent
    logger.info('Sending target state to agent:', {
      uuid: uuid.substring(0, 8),
      configKeys: Object.keys(response[uuid].config),
      hasLogging: !!response[uuid].config.logging,
      hasFeatures: !!response[uuid].config.features,
      hasSettings: !!response[uuid].config.settings,
      hasEndpoints: !!response[uuid].config.endpoints
    });

    // Calculate content size for traffic tracking (even for 304 responses)
    const contentSize = Buffer.byteLength(JSON.stringify(response), 'utf8');

    // Check if changes are pending deployment
    // If needs_deployment is true, return 304 to prevent agent from syncing
    if (targetState.needs_deployment) {
      logger.debug('Changes pending deployment - returning 304 to block sync', { 
        deviceId: uuid.substring(0, 8) 
      });
      return res.set('X-Content-Length', contentSize.toString()).status(304).end();
    }

    // Check if client has current version
    if (ifNoneMatch && ifNoneMatch === etag) {
      logger.debug('ETags match - returning 304 Not Modified', { 
        deviceId: uuid.substring(0, 8) 
      });
      return res.set('X-Content-Length', contentSize.toString()).status(304).end();
    }
    
    logger.debug('ETags differ - sending new state', { 
      deviceId: uuid.substring(0, 8) 
    });

    // Agent is fetching target state to apply pending changes

    // Return target state
    res.set('ETag', etag).json(response);
  } catch (error: any) {
    logger.error('Error getting device state', { 
      error: error.message,
      stack: error.stack,
      deviceId: req.params.uuid
    });
    res.status(500).json({
      error: 'Failed to get device state',
      message: error.message
    });
  }
});

/**
 * Device reports current state
 * PATCH /api/v1/device/state
 */
router.patch('/device/state', deviceAuthFromBody, async (req, res) => {
  try {
    const stateReport = req.body;
    
    // DEBUG: Log the structure of the state report
    const firstUuid = Object.keys(stateReport)[0];
    if (firstUuid) {
      logger.info('State report received', {
        uuid: firstUuid.substring(0, 8),
        keys: Object.keys(stateReport[firstUuid]),
        has_endpoints_health: !!stateReport[firstUuid].endpoints_health,
        endpoints_health_keys: stateReport[firstUuid].endpoints_health ? Object.keys(stateReport[firstUuid].endpoints_health) : []
      });
    }

    // Process state report using shared service
    await processAgentStateReport(stateReport, {
      source: 'http',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });

    res.json({ status: 'ok' });
  } catch (error: any) {
    logger.error('Error processing state report', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      error: 'Failed to process state report',
      message: error.message
    });
  }
});

// ============================================================================
// Management API Endpoints (Cloud-Side - Used by dashboard/admin)
// ============================================================================

/**
 * Get device target state
 * GET /api/v1/devices/:uuid/target-state
 */
router.get('/devices/:uuid/target-state', deviceAuth, async (req, res) => {
  try {
    const { uuid } = req.params;
    const targetState = await DeviceTargetStateModel.get(uuid);

    // Agent is fetching target state to apply pending changes

    res.json({
      uuid,
      apps: targetState ? 
        (typeof targetState.apps === 'string' ? JSON.parse(targetState.apps as any) : targetState.apps) :
        {},
      config: targetState ? 
        (typeof targetState.config === 'string' ? JSON.parse(targetState.config as any) : targetState.config) :
        {},
      version: targetState?.version,
      updated_at: targetState?.updated_at,
    });
  } catch (error: any) {
    logger.error('Error getting target state', {
      error: error.message,
      stack: error.stack,
      deviceId: req.params.uuid
    });
    res.status(500).json({
      error: 'Failed to get target state',
      message: error.message
    });
  }
});

/**
 * Set device target state
 * POST /api/v1/devices/:uuid/target-state
 * 
 * Accepts apps as either:
 * - Array: [{ appId: 1, appName: "app1", ... }, ...]
 * - Object: { 1: { appId: 1, appName: "app1", ... }, ... }
 */
router.post('/devices/:uuid/target-state', deviceAuth, validateTargetStateConfigMiddleware, async (req, res) => {
  try {
    const { uuid } = req.params;
    let { apps, config } = req.body;

    if (!apps || typeof apps !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Body must contain apps (array or object)'
      });
    }

    // Normalize apps to Record<number, App> format
    try {
      apps = normalizeAppsFormat(apps);
    } catch (error: any) {
      return res.status(400).json({
        error: 'Invalid apps format',
        message: error.message
      });
    }

    config = await applyPendingMqttAuth(config || {});
    config = sanitizeAnomalyExpectedRanges(config);
    config = normalizeAnomalyMetricNames(config, uuid);

    // 🎯 RESOLVE IMAGE DIGESTS
    // Convert all :latest and floating tags to @sha256:... digests
    // This enables automatic updates when new images are pushed
    logger.debug('Resolving image digests (POST)', { deviceId: uuid.substring(0, 8) });
    try {
      apps = await resolveAppsImages(apps);
    } catch (error: any) {
      logger.warn('Digest resolution failed, continuing with tag-based references (POST)', {
        deviceId: uuid.substring(0, 8),
        error: error.message
      });
      // Continue with original apps - digest resolution is best-effort
    }

    // Get old state for diff
    const oldTargetState = await DeviceTargetStateModel.get(uuid);

    const targetState = await DeviceTargetStateModel.set(uuid, apps, config || {});

    // 🎉 EVENT SOURCING: Publish target state updated event
    await eventPublisher.publish(
      'target_state.updated',
      'agent',
      uuid,
      {
        new_state: { apps, config },
        old_state: oldTargetState ? {
          apps: typeof oldTargetState.apps === 'string' ? JSON.parse(oldTargetState.apps as any) : oldTargetState.apps,
          config: typeof oldTargetState.config === 'string' ? JSON.parse(oldTargetState.config as any) : oldTargetState.config
        } : { apps: {}, config: {} },
        version: targetState.version,
        apps_added: Object.keys(apps).filter(appId => !oldTargetState?.apps?.[appId]),
        apps_removed: oldTargetState ? Object.keys(oldTargetState.apps || {}).filter(appId => !apps[appId]) : [],
        apps_count: Object.keys(apps).length
      },
      {
        metadata: {
          ip_address: req.ip,
          user_agent: req.headers['user-agent'],
          endpoint: '/devices/:uuid/target-state'
        }
      }
    );

    res.json({
      status: 'ok',
      message: 'Target state updated',
      uuid,
      version: targetState.version,
      apps,
      config,
    });
  } catch (error: any) {
    logger.error('Error setting target state:', error);
    res.status(500).json({
      error: 'Failed to set target state',
      message: error.message
    });
  }
});

/**
 * Convert apps array to Record<number, App> format
 * Supports both array input (clean API) and object input (backward compatibility)
 */
function normalizeAppsFormat(apps: any): Record<number, any> {
  // If already an object, return as-is
  if (!Array.isArray(apps)) {
    return apps;
  }

  // Convert array to object keyed by appId
  return apps.reduce((acc, app) => {
    if (!app.appId) {
      throw new Error('Each app in array must have an appId field');
    }
    acc[app.appId] = app;
    return acc;
  }, {} as Record<number, any>);
}

/**
 * Update device target state (alias for POST - supports PUT)
 * PUT /api/v1/devices/:uuid/target-state
 * 
 * Accepts apps as either:
 * - Array: [{ appId: 1, appName: "app1", ... }, ...]
 * - Object: { 1: { appId: 1, appName: "app1", ... }, ... }
 */
router.put('/devices/:uuid/target-state', validateTargetStateConfigMiddleware, async (req, res) => {
  try {
    const { uuid } = req.params;
    let { apps, config } = req.body;

    if (!apps || typeof apps !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Body must contain apps (array or object)'
      });
    }

    // Normalize apps to Record<number, App> format
    try {
      apps = normalizeAppsFormat(apps);
    } catch (error: any) {
      return res.status(400).json({
        error: 'Invalid apps format',
        message: error.message
      });
    }

    config = await applyPendingMqttAuth(config || {});
    config = sanitizeAnomalyExpectedRanges(config);
    config = normalizeAnomalyMetricNames(config, uuid);

    // 🎯 RESOLVE IMAGE DIGESTS
    // Convert all :latest and floating tags to @sha256:... digests
    logger.debug('Resolving image digests (PUT)', { deviceId: uuid.substring(0, 8) });
    try {
      apps = await resolveAppsImages(apps);
    } catch (error: any) {
      logger.warn('Digest resolution failed, continuing with tag-based references (PUT)', {
        deviceId: uuid.substring(0, 8),
        error: error.message
      });
    }

    // Get old state for diff
    const oldTargetState = await DeviceTargetStateModel.get(uuid);

    // Set needs_deployment = true since config changed
    const targetState = await DeviceTargetStateModel.set(uuid, apps, config || {}, true);

    //EVENT SOURCING: Publish target state updated event
    await eventPublisher.publish(
      'target_state.updated',
      'agent',
      uuid,
      {
        new_state: { apps, config },
        old_state: oldTargetState ? {
          apps: typeof oldTargetState.apps === 'string' ? JSON.parse(oldTargetState.apps as any) : oldTargetState.apps,
          config: typeof oldTargetState.config === 'string' ? JSON.parse(oldTargetState.config as any) : oldTargetState.config
        } : { apps: {}, config: {} },
        version: targetState.version,
        apps_added: Object.keys(apps).filter(appId => !oldTargetState?.apps?.[appId]),
        apps_removed: oldTargetState ? Object.keys(oldTargetState.apps || {}).filter(appId => !apps[appId]) : [],
        apps_count: Object.keys(apps).length
      },
      {
        metadata: {
          ip_address: req.ip,
          user_agent: req.headers['user-agent'],
          endpoint: '/devices/:uuid/target-state'
        }
      }
    );

    res.json({
      status: 'ok',
      message: 'Target state updated',
      uuid,
      version: targetState.version,
      apps,
      config,
    });
  } catch (error: any) {
    logger.error('Error setting target state (PUT)', {
      error: error.message,
      stack: error.stack,
      deviceId: req.params.uuid
    });
    res.status(500).json({
      error: 'Failed to set target state',
      message: error.message
    });
  }
});

/**
 * Get device current state
 * GET /api/v1/devices/:uuid/current-state
 */
router.get('/devices/:uuid/current-state', async (req, res) => {
  try {
    const { uuid } = req.params;
    const currentState = await DeviceCurrentStateModel.get(uuid);

    if (!currentState) {
      return res.status(404).json({
        error: 'No state reported yet',
        message: `Device ${uuid} has not reported its state yet`
      });
    }

    res.json({
      apps: typeof currentState.apps === 'string' ? JSON.parse(currentState.apps as any) : currentState.apps,
      config: typeof currentState.config === 'string' ? JSON.parse(currentState.config as any) : currentState.config,
      system_info: typeof currentState.system_info === 'string' ? JSON.parse(currentState.system_info as any) : currentState.system_info,
      reported_at: currentState.reported_at,
    });
  } catch (error: any) {
    logger.error('Error getting current state', {
      error: error.message,
      stack: error.stack,
      deviceId: req.params.uuid
    });
    res.status(500).json({
      error: 'Failed to get current state',
      message: error.message
    });
  }
});

/**
 * Clear device target state
 * DELETE /api/v1/devices/:uuid/target-state
 */
router.delete('/devices/:uuid/target-state', deviceAuth, async (req, res) => {
  try {
    const { uuid } = req.params;

    await DeviceTargetStateModel.clear(uuid);

    logger.info('Cleared target state', { deviceId: uuid.substring(0, 8) });

    res.json({
      status: 'ok',
      message: 'Target state cleared',
    });
  } catch (error: any) {
    logger.error('Error clearing target state', {
      error: error.message,
      stack: error.stack,
      deviceId: req.params.uuid
    });
    res.status(500).json({
      error: 'Failed to clear target state',
      message: error.message
    });
  }
});


export default router;
