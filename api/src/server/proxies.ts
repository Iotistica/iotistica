/**
 * API Gateway proxy middleware: MQTT Monitor + Postoffice services.
 */

import express from 'express';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';
import logger from '../utils/logger';
import jwtAuth from '../middleware/jwt-auth';
import { API_BASE } from './routes';

function proxyErrorHandler(serviceName: string) {
  return (err: Error, req: express.Request, res: express.Response) => {
    logger.error(`${serviceName} proxy error`, { error: err.message });
    if (!(res as any).headersSent) {
      (res as express.Response)
        .status(502)
        .json({ success: false, error: `${serviceName} service unavailable` });
    }
  };
}

function createServiceProxy(serviceName: string, target: string): RequestHandler {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    on: { error: proxyErrorHandler(serviceName) as any },
    logger,
  });
}

export function mountProxies(app: express.Application): void {
  const MQTT_MONITOR_URL = process.env.MQTT_MONITOR_URL || 'http://mqtt-monitor:3500';
  app.use(
    `${API_BASE}/mqtt-monitor`,
    jwtAuth,
    createServiceProxy('MQTT Monitor', `${MQTT_MONITOR_URL}/api/v1`),
  );

  const POSTOFFICE_URL = process.env.POSTOFFICE_URL || 'http://postoffice:3300';
  app.use(
    `${API_BASE}/postoffice`,
    createServiceProxy('Postoffice', `${POSTOFFICE_URL}/api/v1`),
  );
}
