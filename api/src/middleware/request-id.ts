import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Request ID Middleware - assigns unique ID to each request for tracking and logging
 * This ID is used in error responses for correlation with server logs
 */
export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  (req as any).id = req.headers['x-request-id'] as string || randomUUID();
  res.setHeader('X-Request-ID', (req as any).id);
  next();
};
