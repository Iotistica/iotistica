-- Migration 013: User Invites
-- Stores pending invitations for users to join a tenant
-- Token is stored as a SHA-256 hash (plain token sent in email, never stored)

CREATE TABLE IF NOT EXISTS user_invites (
    id SERIAL PRIMARY KEY,

    -- Target tenant
    customer_id VARCHAR(100) NOT NULL,

    -- Invited email address (may or may not already have an Auth0 account)
    email VARCHAR(255) NOT NULL,

    -- RBAC role to assign on acceptance
    -- Values: owner, admin, manager, operator, viewer
    role VARCHAR(50) NOT NULL,

    -- Who sent the invite (auth0_sub of the admin/owner)
    invited_by_auth0_sub VARCHAR(255) NOT NULL,

    -- SHA-256 hash of the plain invite token (plain token sent in email)
    token_hash VARCHAR(64) NOT NULL UNIQUE,

    -- Invite lifecycle status
    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    -- Token expiry (7 days from creation)
    expires_at TIMESTAMP NOT NULL,

    -- Populated when accepted
    accepted_at TIMESTAMP,
    accepted_auth0_sub VARCHAR(255),

    -- Audit
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT user_invites_valid_status CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    CONSTRAINT user_invites_valid_role CHECK (role IN ('owner', 'admin', 'manager', 'operator', 'viewer')),
    FOREIGN KEY(customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
);

-- Only one active pending invite per email per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_invites_active_email
    ON user_invites(customer_id, email)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_user_invites_customer
    ON user_invites(customer_id);

CREATE INDEX IF NOT EXISTS idx_user_invites_token_hash
    ON user_invites(token_hash);

CREATE INDEX IF NOT EXISTS idx_user_invites_expires_at
    ON user_invites(expires_at);

-- Auto-update updated_at on modification
DROP TRIGGER IF EXISTS update_user_invites_updated_at ON user_invites;
CREATE TRIGGER update_user_invites_updated_at
    BEFORE UPDATE ON user_invites
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE user_invites IS 'Pending invitations for users to join a customer tenant';
COMMENT ON COLUMN user_invites.token_hash IS 'SHA-256 hash of the plain token sent via email; plain token never stored';
COMMENT ON COLUMN user_invites.status IS 'Lifecycle: pending → accepted|revoked|expired';
