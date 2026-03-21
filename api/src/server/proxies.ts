/**
 * API Gateway proxy middleware: MQTT Monitor + Postoffice services.
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import logger from '../utils/logger';
import jwtAuth from '../middleware/jwt-auth';
import { API_BASE } from './routes';

function proxyErrorHandler(serviceName: string) {
  return (err: Error, req: express.Request, res: express.Response) => {
    logger.error(`${serviceName} proxy error`, { error: err.message });
    if (
      'status' in res &&
      'headersSent' in res &&
      typeof (res as any).status === 'function' &&
      !(res as any).headersSent
    ) {
      (res as express.Response)
        .status(502)
        .json({ success: false, error: `${serviceName} service unavailable` });
    }
  };
}

export function mountProxies(app: express.Application): void {
  // MQTT Monitor Service (protected by JWT)
  const MQTT_MONITOR_URL = process.env.MQTT_MONITOR_URL || 'http://mqtt-monitor:3500';
  app.use(
    `${API_BASE}/mqtt-monitor`,
    jwtAuth,
    createProxyMiddleware({
      target: `${MQTT_MONITOR_URL}/api/v1`,
      changeOrigin: true,
      on: { error: proxyErrorHandler('MQTT Monitor') as any },
      logger,
    }),
  );

  // Postoffice (Email) Service
  const POSTOFFICE_URL = process.env.POSTOFFICE_URL || 'http://postoffice:3300';
  app.use(
    `${API_BASE}/postoffice`,
    createProxyMiddleware({
      target: `${POSTOFFICE_URL}/api/v1`,
      changeOrigin: true,
      on: { error: proxyErrorHandler('Postoffice') as any },
      logger,
    }),
  );
}
