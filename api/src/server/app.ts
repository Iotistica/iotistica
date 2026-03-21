/**
 * Express application factory.
 *
 * Creates and fully configures the Express app:
 *   security → middleware → routes → proxies → error handlers.
 *
 * Does NOT start listening - that is handled by server/lifecycle.ts.
 */

import express from 'express';
import { applySecurity } from './security';
import { applyMiddleware } from './middleware';
import { mountRoutes } from './routes';
import { mountProxies } from './proxies';
import logger from '../utils/logger';

export function createApp(): express.Application {
  const app = express();

  applySecurity(app);
  applyMiddleware(app);
  mountRoutes(app);
  mountProxies(app);

  // 404 handler
  app.use((req: express.Request, res: express.Response) => {
    res.status(404).json({
      error: 'Not found',
      message: `Route ${req.method} ${req.path} not found`,
      hint: 'See /api/docs for available endpoints',
    });
  });

  // Global error handler
  app.use(
    (
      err: Error,
      req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction,
    ) => {
      logger.error('Server error', {
        error: err.message,
        stack: err.stack,
        method: req.method,
        path: req.path,
      });
      res.status(500).json({
        error: 'Internal server error',
        message: err.message,
      });
    },
  );

  return app;
}
