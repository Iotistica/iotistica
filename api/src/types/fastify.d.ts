/**
 * Fastify request augmentations.
 * Replaces the old Express `declare global { namespace Express { interface Request { ... } } }` blocks.
 */

import type { JWTPayload } from '../middleware/jwt-auth';

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated dashboard user (set by jwtAuth preHandler). Null when not authenticated. */
    user: {
      id: number;
      username: string;
      email?: string;
      role: string;
      isActive: boolean;
      /** Multi-tenancy: customer ID for boundary enforcement */
      customerId?: string;
    } | null;

    /** Authenticated IoT device (set by deviceAuth preHandler). */
    device?: {
      id: number;
      uuid: string;
      deviceName: string;
      deviceType: string;
      isActive: boolean;
      fleetUuid?: string;
    };

    /** Service-level API key (set by validateApiKey preHandler). */
    apiKey?: {
      id: number;
      name: string;
      description: string | null;
    };

    // Private middleware state – populated by jwtValidate, consumed by downstream preHandlers
    _auth0Payload?: { sub: string; email: string; exp: number };
    _legacyPayload?: JWTPayload;
    _roleData?: { role: string; customer_status: string };
    _dbUser?: { id: number; username: string; email: string; role: string; is_active: boolean };
  }
}
