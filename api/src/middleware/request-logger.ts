/**
 * Winston request logging middleware.
 *
 * - Debug-logs every incoming request (method + path + query + IP)
 * - On response finish: skips 200s to reduce noise; logs 4xx as warn, 5xx as error
 * - MQTT auth paths (/superuser, /acl) are logged at debug level regardless of status
 */

import type { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

const MQTT_AUTH_PATHS = new Set(['/superuser', '/acl']);

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  logger.debug(`${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip,
  });

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    if (res.statusCode === 200) return;

    const logLevel =
      res.statusCode >= 500
        ? 'error'
        : res.statusCode >= 400
          ? 'warn'
          : MQTT_AUTH_PATHS.has(req.path)
            ? 'debug'
            : 'info';

    logger[logLevel](`${res.statusCode} ${req.method} ${req.path} - ${duration}ms`);
  });

  next();
}
