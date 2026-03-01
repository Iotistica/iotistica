-- Add user-tenant role mapping for centralized authorization
-- Migration 012: User Tenant Roles
-- Centralizes all user authorization in provisioning DB (single source of truth)
-- Auth0 handles identity only; this table manages who can do what in which tenant

CREATE TABLE IF NOT EXISTS user_tenant_roles (
    id SERIAL PRIMARY KEY,
    
    -- Auth0 subject (immutable user identifier from Auth0)
    -- Format: "auth0|{auth0-id}" or "google-oauth2|{google-id}", etc.
    auth0_sub VARCHAR(255) NOT NULL,
    
    -- Customer/tenant ID (references customers.customer_id)
    -- One user can have roles in multiple tenants
    customer_id VARCHAR(100) NOT NULL,
    
    -- RBAC role, matches api permission system
    -- Values: owner, admin, manager, operator, viewer
    role VARCHAR(50) NOT NULL,
    
    -- Audit trail
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255),  -- auth0_sub of admin who assigned role, or 'signup_automation'
    
    -- Constraints
    UNIQUE(auth0_sub, customer_id),  -- One role per user per tenant
    FOREIGN KEY(customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
);

CREATE INDEX idx_user_tenant_roles_lookup 
    ON user_tenant_roles(auth0_sub, customer_id);

CREATE INDEX idx_user_tenant_roles_customer 
    ON user_tenant_roles(customer_id);

CREATE INDEX idx_user_tenant_roles_created 
    ON user_tenant_roles(created_at DESC);

-- Trigger to update updated_at on modification
CREATE TRIGGER update_user_tenant_roles_updated_at
    BEFORE UPDATE ON user_tenant_roles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE user_tenant_roles IS 'Centralized user-to-tenant role mapping (single source of truth for authorization)';
COMMENT ON COLUMN user_tenant_roles.auth0_sub IS 'Auth0 subject identifier (immutable, unique user ID from Auth0)';
COMMENT ON COLUMN user_tenant_roles.customer_id IS 'Customer/tenant ID; one user can have roles in multiple tenants';
COMMENT ON COLUMN user_tenant_roles.role IS 'RBAC role: owner, admin, manager, operator, or viewer';
COMMENT ON COLUMN user_tenant_roles.created_by IS 'Audit: who assigned this role (auth0_sub or system)';
