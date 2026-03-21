/**
 * General application middleware: body parsing, decompression,
 * request IDs, traffic logging, and Winston request logging.
 */

import express from 'express';
import { brotliDecompressionMiddleware } from '../middleware/brotli-decompression';
import { requestIdMiddleware } from '../middleware/request-id';
import { trafficLogger } from '../middleware/traffic-logger';
import logger from '../utils/logger';

export function applyMiddleware(app: express.Application): void {
  // Brotli decompression
  app.use(brotliDecompressionMiddleware);

  // Request ID - adds unique ID for tracking and correlation
  app.use(requestIdMiddleware);

  // SECURITY: Body parsing limited to 16MB to prevent DoS via large payloads
  // (16MB compressed = ~60MB+ decompressed, needed for log batches)
  app.use(express.json({ limit: '16mb', inflate: true }));
  app.use(express.urlencoded({ limit: '16mb', extended: true, inflate: true }));

  // Traffic metrics
  app.use(trafficLogger);

  // Winston request logging - skip 200s to reduce noise
  app.use((req, res, next) => {
    const startTime = Date.now();
    const isMqttAuth = req.path === '/superuser' || req.path === '/acl';

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
            : isMqttAuth
              ? 'debug'
              : 'info';

      logger[logLevel](`${res.statusCode} ${req.method} ${req.path} - ${duration}ms`);
    });

    next();
  });
}
