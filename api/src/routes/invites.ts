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

import { Router, Request, Response } from 'express';
import axios from 'axios';
import rateLimit from 'express-rate-limit';
import {
  jwtAuth,
  jwtValidate,
  requireRole,
  generateAccessToken,
  generateRefreshToken,
} from '../middleware/jwt-auth';
import { logger } from '../utils/logger';

const router = Router();

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

// Rate limit for invite creation (prevent spam)
const inviteRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: 'Too many invitations sent. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit for accept endpoint (protect against token brute-force)
const acceptRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: 'Too many accept attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

function internalHeaders() {
  return {
    'X-Internal-Token': INTERNAL_AUTH_TOKEN,
    'Content-Type': 'application/json',
  };
}

function isProvisioningConnectionError(error: any): boolean {
  const connectionCodes = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT']);
  return !error?.response && connectionCodes.has(error?.code);
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

function getFriendlyInviterName(req: Request): string {
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

// ---------------------------------------------------------------------------
// POST /invites
// Create invite + send email
// ---------------------------------------------------------------------------
router.post('/invites',
  jwtAuth,
  requireRole('admin'),
  inviteRateLimit,
  async (req: Request, res: Response) => {
    try {
      const { email, role } = req.body;
      const customerId = req.user?.customerId;
      const auth0Sub = req._auth0Payload?.sub || req._legacyPayload?.auth0Sub;

      if (!customerId) {
        return res.status(400).json({ error: 'Cannot determine tenant from token' });
      }

      if (!email || !role) {
        return res.status(400).json({ error: 'Missing required fields: email, role' });
      }

      // Only owners can invite owners
      if (role === 'owner' && req.user?.role !== 'owner') {
        return res.status(403).json({ error: 'Only owners can invite other owners' });
      }

      const inviterName = getFriendlyInviterName(req);

      // 1. Create invite in provisioning
      const provResponse = await axios.post(
        buildServiceUrl(PROVISIONING_BASE_URL, '/api/internal/invites'),
        {
          customerId,
          email,
          role,
          invitedByAuth0Sub: auth0Sub || 'unknown',
          inviterName,
        },
        { headers: internalHeaders(), timeout: 10000 }
      );

      const { data: invite } = provResponse.data;
      const inviteUrl = `${BASE_URL}/invite/accept?token=${invite.token}`;

      // 2. Send invite email via PostOffice
      await axios.post(
        buildServiceUrl(POSTOFFICE_BASE_URL, '/api/email/send'),
        {
          user: { email, name: email },
          templateName: 'InviteUser',
          context: {
            inviteUrl,
            inviterName,
            companyName: invite.companyName || 'your team',
            role,
          },
        },
        { timeout: 10000 }
      ).catch((emailErr) => {
        // Email failure is non-fatal — log it but don't block the API response
        logger.warn('[invites] Failed to send invite email', {
          email,
          error: emailErr.message,
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

      res.status(201).json({
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
    } catch (error: any) {
      if (error.response?.status === 401) {
        logger.error('[invites] Provisioning rejected create invite internal auth', {
          error: error.response.data?.error || error.message,
        });
        return res.status(502).json({
          error: 'Invitation service authentication failed. Check INTERNAL_AUTH_TOKEN configuration.',
        });
      }
      if (error.response?.status === 403) {
        logger.error('[invites] Provisioning forbidden during create invite', {
          error: error.response.data?.error || error.message,
        });
        return res.status(502).json({
          error: error.response.data?.error || 'Invitation service rejected the request.',
        });
      }
      if (error.response?.status === 409) {
        return res.status(409).json({
          error: error.response.data?.error || 'A pending invitation already exists for this email',
          inviteId: error.response.data?.inviteId,
        });
      }
      if (isProvisioningConnectionError(error)) {
        logger.error('[invites] Provisioning unavailable during create invite', {
          error: error.message,
          provisioningUrl: PROVISIONING_BASE_URL,
        });
        return res.status(503).json({
          error: 'Invitation service is temporarily unavailable. Please try again shortly.',
        });
      }
      logger.error('[invites] Create invite error:', { error: error.message });
      res.status(500).json({ error: 'Failed to create invitation' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /invites
// List invites for the current tenant
// ---------------------------------------------------------------------------
router.get('/invites',
  jwtAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const customerId = req.user?.customerId;
      if (!customerId) {
        return res.status(400).json({ error: 'Cannot determine tenant from token' });
      }

      const provResponse = await axios.get(
        buildServiceUrl(PROVISIONING_BASE_URL, '/api/internal/invites', { customerId }),
        { headers: internalHeaders(), timeout: 10000 }
      );

      res.json(provResponse.data);
    } catch (error: any) {
      if (error.response?.status === 401) {
        logger.error('[invites] Provisioning rejected list invites internal auth', {
          error: error.response.data?.error || error.message,
        });
        return res.status(502).json({
          error: 'Invitation service authentication failed. Check INTERNAL_AUTH_TOKEN configuration.',
        });
      }
      if (isProvisioningConnectionError(error)) {
        logger.warn('[invites] Provisioning unavailable during list invites, returning empty list', {
          error: error.message,
          provisioningUrl: PROVISIONING_BASE_URL,
        });
        return res.json({ data: [] });
      }
      logger.error('[invites] List invites error:', { error: error.message });
      res.status(500).json({ error: 'Failed to list invitations' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /invites/:id/resend
// Regenerate token + resend email
// ---------------------------------------------------------------------------
router.post('/invites/:id/resend',
  jwtAuth,
  requireRole('admin'),
  inviteRateLimit,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const customerId = req.user?.customerId;
      const inviterName = getFriendlyInviterName(req);

      if (!customerId) {
        return res.status(400).json({ error: 'Cannot determine tenant from token' });
      }

      // 1. Regenerate token in provisioning
      const provResponse = await axios.post(
        buildServiceUrl(PROVISIONING_BASE_URL, `/api/internal/invites/${id}/resend`),
        { customerId },
        { headers: internalHeaders(), timeout: 10000 }
      );

      const { data: invite } = provResponse.data;
      const inviteUrl = `${BASE_URL}/invite/accept?token=${invite.token}`;

      // 2. Resend email
      await axios.post(
        buildServiceUrl(POSTOFFICE_BASE_URL, '/api/email/send'),
        {
          user: { email: invite.email, name: invite.email },
          templateName: 'InviteUser',
          context: {
            inviteUrl,
            inviterName,
            companyName: invite.companyName || 'your team',
            role: invite.role,
          },
        },
        { timeout: 10000 }
      ).catch((emailErr) => {
        logger.warn('[invites] Failed to resend invite email', {
          email: invite.email,
          error: emailErr.message,
        });
      });

      res.json({ message: `Invitation resent to ${invite.email}` });
    } catch (error: any) {
      if (error.response?.status === 401) {
        logger.error('[invites] Provisioning rejected resend invite internal auth', {
          error: error.response.data?.error || error.message,
        });
        return res.status(502).json({
          error: 'Invitation service authentication failed. Check INTERNAL_AUTH_TOKEN configuration.',
        });
      }
      if (error.response?.status === 404) {
        return res.status(404).json({ error: 'Pending invite not found' });
      }
      if (isProvisioningConnectionError(error)) {
        logger.error('[invites] Provisioning unavailable during resend invite', {
          error: error.message,
          provisioningUrl: PROVISIONING_BASE_URL,
        });
        return res.status(503).json({
          error: 'Invitation service is temporarily unavailable. Please try again shortly.',
        });
      }
      logger.error('[invites] Resend invite error:', { error: error.message });
      res.status(500).json({ error: 'Failed to resend invitation' });
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /invites/:id
// Revoke a pending invite
// ---------------------------------------------------------------------------
router.delete('/invites/:id',
  jwtAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const customerId = req.user?.customerId;

      if (!customerId) {
        return res.status(400).json({ error: 'Cannot determine tenant from token' });
      }

      await axios.post(
        buildServiceUrl(PROVISIONING_BASE_URL, `/api/internal/invites/${id}/revoke`),
        { customerId },
        { headers: internalHeaders(), timeout: 10000 }
      );

      res.status(204).send();
    } catch (error: any) {
      if (error.response?.status === 401) {
        logger.error('[invites] Provisioning rejected revoke invite internal auth', {
          error: error.response.data?.error || error.message,
        });
        return res.status(502).json({
          error: 'Invitation service authentication failed. Check INTERNAL_AUTH_TOKEN configuration.',
        });
      }
      if (error.response?.status === 404) {
        return res.status(404).json({ error: 'Invite not found or already resolved' });
      }
      if (isProvisioningConnectionError(error)) {
        logger.error('[invites] Provisioning unavailable during revoke invite', {
          error: error.message,
          provisioningUrl: PROVISIONING_BASE_URL,
        });
        return res.status(503).json({
          error: 'Invitation service is temporarily unavailable. Please try again shortly.',
        });
      }
      logger.error('[invites] Revoke invite error:', { error: error.message });
      res.status(500).json({ error: 'Failed to revoke invitation' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /invites/accept
// Accept an invite — requires Auth0 JWT (jwtValidate only, no tenant membership)
// Returns a new HS256 federated JWT pair for the accepted tenant
// ---------------------------------------------------------------------------
router.post('/invites/accept',
  acceptRateLimit,
  jwtValidate,
  async (req: Request, res: Response) => {
    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({ error: 'Missing required field: token' });
      }

      // Extract auth0Sub from the validated JWT (Auth0 RS256 or HS256 federated)
      const auth0Sub = req._auth0Payload?.sub || req._legacyPayload?.auth0Sub;

      const email = req._auth0Payload?.email || req._legacyPayload?.email || req.user?.email;

      if (!auth0Sub) {
        return res.status(401).json({
          error: 'Cannot determine identity. Please log in with Auth0 before accepting an invitation.',
        });
      }

      // Call provisioning to accept the invite
      const provResponse = await axios.post(
        buildServiceUrl(PROVISIONING_BASE_URL, `/api/internal/invites/${encodeURIComponent(token)}/accept`),
        { auth0Sub, email },
        { headers: internalHeaders(), timeout: 10000 }
      );

      const { data } = provResponse.data;
      const { customerId, role } = data;

      // Issue federated JWT pair for the newly joined tenant
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

      res.json({
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
    } catch (error: any) {
      if (error.response?.status === 401) {
        logger.error('[invites] Provisioning rejected accept invite internal auth', {
          error: error.response.data?.error || error.message,
        });
        return res.status(502).json({
          error: 'Invitation service authentication failed. Check INTERNAL_AUTH_TOKEN configuration.',
        });
      }
      if (error.response?.status === 404) {
        return res.status(404).json({ error: 'Invalid or expired invitation link' });
      }
      if (error.response?.status === 409) {
        return res.status(409).json({ error: error.response.data?.error || 'Invitation already used' });
      }
      if (error.response?.status === 410) {
        return res.status(410).json({ error: 'Invitation has expired. Please request a new one.' });
      }
      if (error.response?.status === 403) {
        return res.status(403).json({ error: error.response.data?.error || 'Invitation not valid for this account' });
      }
      if (isProvisioningConnectionError(error)) {
        logger.error('[invites] Provisioning unavailable during accept invite', {
          error: error.message,
          provisioningUrl: PROVISIONING_BASE_URL,
        });
        return res.status(503).json({
          error: 'Invitation service is temporarily unavailable. Please try again shortly.',
        });
      }
      logger.error('[invites] Accept invite error:', { error: error.message });
      res.status(500).json({ error: 'Failed to accept invitation' });
    }
  }
);

export default router;
