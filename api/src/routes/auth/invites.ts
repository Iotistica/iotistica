/**
 * Invite Routes (Customer API)
 *
 * Allows tenant admins to invite users by email. The invited user receives
 * an email with an accept link. On acceptance, their Auth0 identity is linked
 * to the tenant via the provisioning service.
 *
 * Endpoints:
 *   POST   /invites              - Create invite and send email  (admin+)
 *   GET    /invites              - List all invites for tenant   (admin+)
 *   POST   /invites/:id/resend   - Resend invite email           (admin+)
 *   DELETE /invites/:id          - Revoke pending invite         (admin+)
 *   POST   /invites/accept       - Accept an invite              (jwtValidate only)
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { fetch } from 'undici';

import {
  generateAccessToken,
  generateRefreshToken,
  jwtAuth,
  jwtValidate,
  requireRole,
} from '../../middleware/jwt-auth';
import { logger } from '../../utils/logger';

interface InviteCreateBody {
  email?: string;
  role?: string;
}

interface InviteIdParams {
  id: string;
}

interface InviteAcceptBody {
  token?: string;
}

interface InviteRecord {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at?: string;
  created_at?: string;
  token?: string;
  companyName?: string;
}

interface AcceptedInviteResult {
  customerId: string;
  role: string;
}

interface ProvisioningEnvelope<T> {
  data: T;
}

interface ResponseErrorData {
  error?: string;
  inviteId?: string;
}

type HttpError = Error & {
  response?: {
    status?: number;
    data?: ResponseErrorData;
  };
};

const PROVISIONING_BASE_URL = process.env.PROVISIONING_API_URL
  || `http://localhost:${process.env.PROVISIONING_PORT || '3100'}`;
const POSTOFFICE_BASE_URL = process.env.POSTOFFICE_URL
  || `http://localhost:${process.env.POSTOFFICE_PORT || '3300'}`;
const INTERNAL_AUTH_TOKEN = process.env.INTERNAL_AUTH_TOKEN || '';
const BASE_URL = process.env.BASE_URL || 'https://iotistica.com';

function buildServiceUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(normalizedPath, normalizedBaseUrl);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

const inviteRateLimit = {
  max: 20,
  timeWindow: 60 * 60 * 1000,
  keyGenerator: (request: FastifyRequest) => `invite:${request.user?.id ?? request.ip}`,
  errorResponseBuilder: () => ({
    error: 'Too many requests',
    message: 'Too many invitations sent. Please try again later.',
  }),
};

const acceptRateLimit = {
  max: 10,
  timeWindow: 15 * 60 * 1000,
  keyGenerator: (request: FastifyRequest) => `invite-accept:${request.ip}`,
  errorResponseBuilder: () => ({
    error: 'Too many requests',
    message: 'Too many accept attempts. Please try again later.',
  }),
};

function internalHeaders(): Record<string, string> {
  return {
    'X-Internal-Token': INTERNAL_AUTH_TOKEN,
    'Content-Type': 'application/json',
  };
}

function isProvisioningConnectionError(error: unknown): boolean {
  const maybeError = error as HttpError | undefined;
  return !maybeError?.response;
}

async function fetchJson<T>(
  method: string,
  url: string,
  options: { body?: unknown; headers?: Record<string, string>; timeout?: number } = {}
): Promise<{ data: T }> {
  const { body, headers = {}, timeout = 10000 } = options;
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    let responseData: ResponseErrorData | null = null;
    try {
      responseData = await response.json() as ResponseErrorData;
    } catch {
      responseData = null;
    }

    const errorMessage = responseData?.error || `HTTP ${response.status}`;
    const error = new Error(errorMessage) as HttpError;
    error.response = {
      status: response.status,
      data: responseData ?? undefined,
    };
    throw error;
  }

  return { data: await response.json() as T };
}

function isAuth0Subject(value?: string): boolean {
  return typeof value === 'string' && /^[^|]+\|.+$/.test(value);
}

function toTitleCaseFromEmail(email: string): string {
  const localPart = email.split('@')[0] || '';
  const words = localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

  return words.join(' ') || 'A team member';
}

function getFriendlyInviterName(req: FastifyRequest): string {
  const username = req.user?.username;
  const legacyPreferred = req._legacyPayload?.username;

  if (legacyPreferred && !isAuth0Subject(legacyPreferred)) {
    return legacyPreferred;
  }

  if (username && !isAuth0Subject(username)) {
    return username;
  }

  const inviterEmail = req.user?.email || req._auth0Payload?.email;
  if (inviterEmail) {
    return toTitleCaseFromEmail(inviterEmail);
  }

  return 'A team member';
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: InviteCreateBody }>('/invites', {
    preHandler: [jwtAuth, requireRole('admin')],
    config: { rateLimit: inviteRateLimit },
  }, async (req, reply) => {
    try {
      const { email, role } = req.body;
      const customerId = req.user?.customerId;
      const auth0Sub = req._auth0Payload?.sub || req._legacyPayload?.auth0Sub;

      if (!customerId) {
        return reply.status(400).send({ error: 'Cannot determine tenant from token' });
      }

      if (!email || !role) {
        return reply.status(400).send({ error: 'Missing required fields: email, role' });
      }

      if (role === 'owner' && req.user?.role !== 'owner') {
        return reply.status(403).send({ error: 'Only owners can invite other owners' });
      }

      const inviterName = getFriendlyInviterName(req);

      const provResponse = await fetchJson<ProvisioningEnvelope<InviteRecord>>(
        'POST',
        buildServiceUrl(PROVISIONING_BASE_URL, '/api/internal/invites'),
        {
          body: {
            customerId,
            email,
            role,
            invitedByAuth0Sub: auth0Sub || 'unknown',
            inviterName,
          },
          headers: internalHeaders(),
        }
      );

      const { data: invite } = provResponse.data;
      const inviteUrl = `${BASE_URL}/invite/accept?token=${invite.token}`;

      await fetchJson('POST', buildServiceUrl(POSTOFFICE_BASE_URL, '/api/email/send'), {
        body: {
          user: { email, name: email },
          templateName: 'InviteUser',
          context: {
            inviteUrl,
            inviterName,
            companyName: invite.companyName || 'your team',
            role,
          },
        },
      }).catch((emailError: unknown) => {
        logger.warn('[invites] Failed to send invite email', {
          email,
          error: emailError instanceof Error ? emailError.message : 'Unknown error',
          inviteId: invite.id,
        });
      });

      logger.info('[invites] Invitation created', {
        inviteId: invite.id,
        email,
        role,
        customerId,
        invitedBy: auth0Sub,
      });

      return reply.status(201).send({
        message: `Invitation sent to ${email}`,
        invite: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          status: invite.status,
          expires_at: invite.expires_at,
          created_at: invite.created_at,
        },
      });
    } catch (error: unknown) {
      const responseError = error as HttpError;
      if (responseError.response?.status === 401) {
        logger.error('[invites] Provisioning rejected create invite internal auth', {
          error: responseError.response.data?.error || responseError.message,
        });
        return reply.status(502).send({
          error: 'Invitation service authentication failed. Check INTERNAL_AUTH_TOKEN configuration.',
        });
      }
      if (responseError.response?.status === 403) {
        logger.error('[invites] Provisioning forbidden during create invite', {
          error: responseError.response.data?.error || responseError.message,
        });
        return reply.status(502).send({
          error: responseError.response.data?.error || 'Invitation service rejected the request.',
        });
      }
      if (responseError.response?.status === 409) {
        return reply.status(409).send({
          error: responseError.response.data?.error || 'A pending invitation already exists for this email',
          inviteId: responseError.response.data?.inviteId,
        });
      }
      if (isProvisioningConnectionError(responseError)) {
        logger.error('[invites] Provisioning unavailable during create invite', {
          error: responseError.message,
          provisioningUrl: PROVISIONING_BASE_URL,
        });
        return reply.status(503).send({
          error: 'Invitation service is temporarily unavailable. Please try again shortly.',
        });
      }
      logger.error('[invites] Create invite error:', { error: responseError.message });
      return reply.status(500).send({ error: 'Failed to create invitation' });
    }
  });

  fastify.get('/invites', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const customerId = req.user?.customerId;
      if (!customerId) {
        return reply.status(400).send({ error: 'Cannot determine tenant from token' });
      }

      const provResponse = await fetchJson<unknown>(
        'GET',
        buildServiceUrl(PROVISIONING_BASE_URL, '/api/internal/invites', { customerId }),
        { headers: internalHeaders() }
      );

      return reply.send(provResponse.data);
    } catch (error: unknown) {
      const responseError = error as HttpError;
      if (responseError.response?.status === 401) {
        logger.error('[invites] Provisioning rejected list invites internal auth', {
          error: responseError.response.data?.error || responseError.message,
        });
        return reply.status(502).send({
          error: 'Invitation service authentication failed. Check INTERNAL_AUTH_TOKEN configuration.',
        });
      }
      if (isProvisioningConnectionError(responseError)) {
        logger.warn('[invites] Provisioning unavailable during list invites, returning empty list', {
          error: responseError.message,
          provisioningUrl: PROVISIONING_BASE_URL,
        });
        return reply.send({ data: [] });
      }
      logger.error('[invites] List invites error:', { error: responseError.message });
      return reply.status(500).send({ error: 'Failed to list invitations' });
    }
  });

  fastify.post<{ Params: InviteIdParams }>('/invites/:id/resend', {
    preHandler: [jwtAuth, requireRole('admin')],
    config: { rateLimit: inviteRateLimit },
  }, async (req, reply) => {
    try {
      const { id } = req.params;
      const customerId = req.user?.customerId;
      const inviterName = getFriendlyInviterName(req);

      if (!customerId) {
        return reply.status(400).send({ error: 'Cannot determine tenant from token' });
      }

      const provResponse = await fetchJson<ProvisioningEnvelope<InviteRecord>>(
        'POST',
        buildServiceUrl(PROVISIONING_BASE_URL, `/api/internal/invites/${id}/resend`),
        {
          body: { customerId },
          headers: internalHeaders(),
        }
      );

      const { data: invite } = provResponse.data;
      const inviteUrl = `${BASE_URL}/invite/accept?token=${invite.token}`;

      await fetchJson('POST', buildServiceUrl(POSTOFFICE_BASE_URL, '/api/email/send'), {
        body: {
          user: { email: invite.email, name: invite.email },
          templateName: 'InviteUser',
          context: {
            inviteUrl,
            inviterName,
            companyName: invite.companyName || 'your team',
            role: invite.role,
          },
        },
      }).catch((emailError: unknown) => {
        logger.warn('[invites] Failed to resend invite email', {
          email: invite.email,
          error: emailError instanceof Error ? emailError.message : 'Unknown error',
        });
      });

      return reply.send({ message: `Invitation resent to ${invite.email}` });
    } catch (error: unknown) {
      const responseError = error as HttpError;
      if (responseError.response?.status === 401) {
        logger.error('[invites] Provisioning rejected resend invite internal auth', {
          error: responseError.response.data?.error || responseError.message,
        });
        return reply.status(502).send({
          error: 'Invitation service authentication failed. Check INTERNAL_AUTH_TOKEN configuration.',
        });
      }
      if (responseError.response?.status === 404) {
        return reply.status(404).send({ error: 'Pending invite not found' });
      }
      if (isProvisioningConnectionError(responseError)) {
        logger.error('[invites] Provisioning unavailable during resend invite', {
          error: responseError.message,
          provisioningUrl: PROVISIONING_BASE_URL,
        });
        return reply.status(503).send({
          error: 'Invitation service is temporarily unavailable. Please try again shortly.',
        });
      }
      logger.error('[invites] Resend invite error:', { error: responseError.message });
      return reply.status(500).send({ error: 'Failed to resend invitation' });
    }
  });

  fastify.delete<{ Params: InviteIdParams }>('/invites/:id', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
    try {
      const { id } = req.params;
      const customerId = req.user?.customerId;

      if (!customerId) {
        return reply.status(400).send({ error: 'Cannot determine tenant from token' });
      }

      await fetchJson(
        'POST',
        buildServiceUrl(PROVISIONING_BASE_URL, `/api/internal/invites/${id}/revoke`),
        {
          body: { customerId },
          headers: internalHeaders(),
        }
      );

      return reply.status(204).send();
    } catch (error: unknown) {
      const responseError = error as HttpError;
      if (responseError.response?.status === 401) {
        logger.error('[invites] Provisioning rejected revoke invite internal auth', {
          error: responseError.response.data?.error || responseError.message,
        });
        return reply.status(502).send({
          error: 'Invitation service authentication failed. Check INTERNAL_AUTH_TOKEN configuration.',
        });
      }
      if (responseError.response?.status === 404) {
        return reply.status(404).send({ error: 'Invite not found or already resolved' });
      }
      if (isProvisioningConnectionError(responseError)) {
        logger.error('[invites] Provisioning unavailable during revoke invite', {
          error: responseError.message,
          provisioningUrl: PROVISIONING_BASE_URL,
        });
        return reply.status(503).send({
          error: 'Invitation service is temporarily unavailable. Please try again shortly.',
        });
      }
      logger.error('[invites] Revoke invite error:', { error: responseError.message });
      return reply.status(500).send({ error: 'Failed to revoke invitation' });
    }
  });

  fastify.post<{ Body: InviteAcceptBody }>('/invites/accept', {
    preHandler: [jwtValidate],
    config: { rateLimit: acceptRateLimit },
  }, async (req, reply) => {
    try {
      const { token } = req.body;

      if (!token) {
        return reply.status(400).send({ error: 'Missing required field: token' });
      }

      const auth0Sub = req._auth0Payload?.sub || req._legacyPayload?.auth0Sub;
      const email = req._auth0Payload?.email || req._legacyPayload?.email || req.user?.email;

      if (!auth0Sub) {
        return reply.status(401).send({
          error: 'Cannot determine identity. Please log in with Auth0 before accepting an invitation.',
        });
      }

      const provResponse = await fetchJson<ProvisioningEnvelope<AcceptedInviteResult>>(
        'POST',
        buildServiceUrl(PROVISIONING_BASE_URL, `/api/internal/invites/${encodeURIComponent(token)}/accept`),
        {
          body: { auth0Sub, email },
          headers: internalHeaders(),
        }
      );

      const { data } = provResponse.data;
      const { customerId, role } = data;

      const accessToken = generateAccessToken({
        id: 0,
        username: auth0Sub,
        email: email || auth0Sub,
        role,
        auth0Sub,
        customerId,
      });

      const refreshToken = generateRefreshToken({
        id: 0,
        username: auth0Sub,
        email: email || auth0Sub,
        role,
        auth0Sub,
        customerId,
      });

      logger.info('[invites] Invite accepted', { auth0Sub, customerId, role });

      return reply.send({
        message: 'Invitation accepted successfully',
        accessToken,
        refreshToken,
        user: {
          auth0Sub,
          email: email || auth0Sub,
          role,
          customerId,
        },
      });
    } catch (error: unknown) {
      const responseError = error as HttpError;
      if (responseError.response?.status === 401) {
        logger.error('[invites] Provisioning rejected accept invite internal auth', {
          error: responseError.response.data?.error || responseError.message,
        });
        return reply.status(502).send({
          error: 'Invitation service authentication failed. Check INTERNAL_AUTH_TOKEN configuration.',
        });
      }
      if (responseError.response?.status === 404) {
        return reply.status(404).send({ error: 'Invalid or expired invitation link' });
      }
      if (responseError.response?.status === 409) {
        return reply.status(409).send({ error: responseError.response.data?.error || 'Invitation already used' });
      }
      if (responseError.response?.status === 410) {
        return reply.status(410).send({ error: 'Invitation has expired. Please request a new one.' });
      }
      if (responseError.response?.status === 403) {
        return reply.status(403).send({ error: responseError.response.data?.error || 'Invitation not valid for this account' });
      }
      if (isProvisioningConnectionError(responseError)) {
        logger.error('[invites] Provisioning unavailable during accept invite', {
          error: responseError.message,
          provisioningUrl: PROVISIONING_BASE_URL,
        });
        return reply.status(503).send({
          error: 'Invitation service is temporarily unavailable. Please try again shortly.',
        });
      }
      logger.error('[invites] Accept invite error:', { error: responseError.message });
      return reply.status(500).send({ error: 'Failed to accept invitation' });
    }
  });
};

export default plugin;