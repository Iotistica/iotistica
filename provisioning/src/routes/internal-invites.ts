/**
 * Internal Invite Endpoints (Provisioning Service)
 *
 * Called by the customer API to manage user invitations.
 * All endpoints require X-Internal-Token header.
 *
 * Routes:
 *   POST   /invites                  - Create invite, return plain token
 *   GET    /invites?customerId=...   - List invites for a tenant
 *   POST   /invites/:token/accept    - Accept invite (links Auth0 user to tenant)
 *   POST   /invites/:id/revoke       - Revoke a pending invite
 *   POST   /invites/:id/resend       - Regenerate token + resend (handled by API layer)
 */

import { Router, Request, Response } from 'express';
import { query } from '../db/connection';
import { timingSafeEqual } from 'crypto';
import crypto from 'crypto';

const router = Router();

const INVITE_EXPIRY_DAYS = 7;

// ---------------------------------------------------------------------------
// Internal token guard (reused from internal-rbac.ts pattern)
// ---------------------------------------------------------------------------
function verifyInternalToken(req: Request, res: Response, next: Function) {
  const token = req.headers['x-internal-token'] as string;
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN;

  if (!expectedToken) {
    console.error('FATAL: INTERNAL_AUTH_TOKEN not configured');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing X-Internal-Token header' });
  }

  try {
    const tokenBuffer = Buffer.from(token);
    const expectedBuffer = Buffer.from(expectedToken);

    if (tokenBuffer.length !== expectedBuffer.length) {
      return res.status(401).json({ error: 'Invalid internal token' });
    }

    if (!timingSafeEqual(tokenBuffer, expectedBuffer)) {
      return res.status(401).json({ error: 'Invalid internal token' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid internal token' });
  }

  next();
}

router.use(verifyInternalToken);

// ---------------------------------------------------------------------------
// POST /invites
// Create an invitation and return the plain token (caller sends the email)
// ---------------------------------------------------------------------------
router.post('/invites', async (req: Request, res: Response) => {
  try {
    const { customerId, email, role, invitedByAuth0Sub, inviterName, companyName } = req.body;

    if (!customerId || !email || !role || !invitedByAuth0Sub) {
      return res.status(400).json({ error: 'Missing required fields: customerId, email, role, invitedByAuth0Sub' });
    }

    const validRoles = ['owner', 'admin', 'manager', 'operator', 'viewer'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Verify customer exists
    const customerResult = await query(
      'SELECT customer_id, company_name FROM customers WHERE customer_id = $1 AND is_active = true',
      [customerId]
    );
    if (customerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Block inviting someone who already has a role in this tenant
    const existingRole = await query(
      'SELECT role FROM user_tenant_roles WHERE customer_id = $1 AND auth0_sub IN (SELECT sub FROM auth0_users WHERE email = $2)',
      [customerId, email]
    ).catch(() => ({ rows: [] })); // Ignore if auth0_users table doesn't exist yet

    // Check for existing pending invite (unique index prevents duplicates, but give a clear error)
    const existingInvite = await query(
      `SELECT id FROM user_invites WHERE customer_id = $1 AND email = $2 AND status = 'pending'`,
      [customerId, email.toLowerCase()]
    );
    if (existingInvite.rows.length > 0) {
      return res.status(409).json({
        error: 'A pending invitation already exists for this email address. Revoke it first, or resend it.',
        inviteId: existingInvite.rows[0].id,
      });
    }

    // Generate a cryptographically secure 32-byte token
    const plainToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(plainToken).digest('hex');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRY_DAYS);

    const result = await query(
      `INSERT INTO user_invites
         (customer_id, email, role, invited_by_auth0_sub, token_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       RETURNING id, customer_id, email, role, status, expires_at, created_at`,
      [customerId, email.toLowerCase(), role, invitedByAuth0Sub, tokenHash, expiresAt]
    );

    const invite = result.rows[0];

    res.status(201).json({
      success: true,
      data: {
        ...invite,
        // Return the plain token so the API layer can build the link + send the email
        token: plainToken,
        companyName: customerResult.rows[0].company_name,
        inviterName: inviterName || invitedByAuth0Sub,
      },
    });
  } catch (error: any) {
    console.error('[internal-invites] Create invite error:', error.message);
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

// ---------------------------------------------------------------------------
// GET /invites?customerId=...
// List all invites for a tenant (all statuses)
// ---------------------------------------------------------------------------
router.get('/invites', async (req: Request, res: Response) => {
  try {
    const { customerId } = req.query;

    if (!customerId) {
      return res.status(400).json({ error: 'Missing required query param: customerId' });
    }

    const result = await query(
      `SELECT id, customer_id, email, role, invited_by_auth0_sub, status,
              expires_at, accepted_at, accepted_auth0_sub, created_at, updated_at
       FROM user_invites
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [customerId]
    );

    res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('[internal-invites] List invites error:', error.message);
    res.status(500).json({ error: 'Failed to list invitations' });
  }
});

// ---------------------------------------------------------------------------
// POST /invites/:token/accept
// Accept an invitation: write user_tenant_roles, mark invite as accepted
// Body: { auth0Sub: string, email: string }
// ---------------------------------------------------------------------------
router.post('/invites/:token/accept', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { auth0Sub, email } = req.body;

    if (!token || !auth0Sub) {
      return res.status(400).json({ error: 'Missing required fields: token, auth0Sub' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Fetch invite by token hash
    const inviteResult = await query(
      `SELECT * FROM user_invites WHERE token_hash = $1`,
      [tokenHash]
    );

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired invitation link' });
    }

    const invite = inviteResult.rows[0];

    if (invite.status !== 'pending') {
      return res.status(409).json({
        error: `Invitation has already been ${invite.status}`,
        status: invite.status,
      });
    }

    if (new Date() > new Date(invite.expires_at)) {
      // Mark as expired
      await query(
        `UPDATE user_invites SET status = 'expired', updated_at = NOW() WHERE id = $1`,
        [invite.id]
      );
      return res.status(410).json({ error: 'Invitation has expired. Please request a new one.' });
    }

    // Optional: validate that the accepting user's email matches the invited email
    if (email && email.toLowerCase() !== invite.email.toLowerCase()) {
      return res.status(403).json({
        error: 'This invitation was sent to a different email address',
      });
    }

    // Check if user already has a role in this tenant
    const existingRole = await query(
      `SELECT role FROM user_tenant_roles WHERE auth0_sub = $1 AND customer_id = $2`,
      [auth0Sub, invite.customer_id]
    );

    if (existingRole.rows.length > 0) {
      // User already a member — accept and return their current role
      await query(
        `UPDATE user_invites SET status = 'accepted', accepted_at = NOW(), accepted_auth0_sub = $1, updated_at = NOW()
         WHERE id = $2`,
        [auth0Sub, invite.id]
      );
      return res.json({
        success: true,
        data: {
          customerId: invite.customer_id,
          role: existingRole.rows[0].role,
          alreadyMember: true,
        },
      });
    }

    // Write the tenant role mapping
    await query(
      `INSERT INTO user_tenant_roles (auth0_sub, customer_id, role, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (auth0_sub, customer_id) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
      [auth0Sub, invite.customer_id, invite.role, invite.invited_by_auth0_sub]
    );

    // Mark invite as accepted
    await query(
      `UPDATE user_invites
       SET status = 'accepted', accepted_at = NOW(), accepted_auth0_sub = $1, updated_at = NOW()
       WHERE id = $2`,
      [auth0Sub, invite.id]
    );

    res.json({
      success: true,
      data: {
        customerId: invite.customer_id,
        role: invite.role,
        alreadyMember: false,
      },
    });
  } catch (error: any) {
    console.error('[internal-invites] Accept invite error:', error.message);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

// ---------------------------------------------------------------------------
// POST /invites/:id/revoke
// Revoke a pending invitation
// ---------------------------------------------------------------------------
router.post('/invites/:id/revoke', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { customerId } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: 'Missing required field: customerId' });
    }

    const result = await query(
      `UPDATE user_invites
       SET status = 'revoked', updated_at = NOW()
       WHERE id = $1 AND customer_id = $2 AND status = 'pending'
       RETURNING id, email, status`,
      [id, customerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found or already resolved' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('[internal-invites] Revoke invite error:', error.message);
    res.status(500).json({ error: 'Failed to revoke invitation' });
  }
});

// ---------------------------------------------------------------------------
// POST /invites/:id/resend
// Regenerate the invite token (refreshes expiry) — returns new plain token
// ---------------------------------------------------------------------------
router.post('/invites/:id/resend', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { customerId } = req.body;

    if (!customerId) {
      return res.status(400).json({ error: 'Missing required field: customerId' });
    }

    const existing = await query(
      `SELECT * FROM user_invites WHERE id = $1 AND customer_id = $2 AND status = 'pending'`,
      [id, customerId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Pending invite not found' });
    }

    const plainToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(plainToken).digest('hex');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITE_EXPIRY_DAYS);

    const result = await query(
      `UPDATE user_invites
       SET token_hash = $1, expires_at = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, customer_id, email, role, status, expires_at`,
      [tokenHash, expiresAt, id]
    );

    res.json({
      success: true,
      data: {
        ...result.rows[0],
        token: plainToken,
      },
    });
  } catch (error: any) {
    console.error('[internal-invites] Resend invite error:', error.message);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

export default router;
