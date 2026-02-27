-- Migration: Add user authentication and MQTT ACL tables
-- Created: 2025-10-19
-- Purpose: Unified authentication for dashboard users and MQTT broker
-- Compatible with: mosquitto-go-auth PostgreSQL backend
-- ============================================================================
-- USER AUTHENTICATION TABLES
-- ============================================================================
-- Users table for dashboard authentication
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,  -- bcrypt hashed password
    full_name VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'user',  -- admin, user, viewer
    is_active BOOLEAN DEFAULT true,
    email_verified BOOLEAN DEFAULT false,
    last_login_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_role CHECK (role IN ('admin', 'user', 'viewer', 'device'))
);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_is_active ON users(is_active);
-- JWT refresh tokens for persistent sessions
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,  -- bcrypt hashed refresh token
    device_info TEXT,  -- User agent, device identifier
    ip_address INET,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP,
    revoked BOOLEAN DEFAULT false,
    revoked_at TIMESTAMP
);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
CREATE INDEX idx_refresh_tokens_revoked ON refresh_tokens(revoked);
-- User sessions for tracking active logins
CREATE TABLE IF NOT EXISTS user_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    ip_address INET,
    user_agent TEXT,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);
-- ============================================================================
-- MQTT AUTHENTICATION & ACL TABLES (mosquitto-go-auth compatible)
-- ============================================================================
-- MQTT users table (for mosquitto-go-auth PostgreSQL backend)
-- This table is queried by mosquitto-go-auth for authentication
CREATE TABLE IF NOT EXISTS mqtt_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,  -- PBKDF2, bcrypt, or Argon2 hash
    is_superuser BOOLEAN DEFAULT false,  -- Bypass all ACL checks if true
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_mqtt_users_username ON mqtt_users(username);
CREATE INDEX idx_mqtt_users_is_active ON mqtt_users(is_active);
-- MQTT ACL table (for mosquitto-go-auth PostgreSQL backend)
-- Defines topic access control rules
CREATE TABLE IF NOT EXISTS mqtt_acls (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255),  -- NULL = applies to all users
    clientid VARCHAR(255),  -- NULL = applies to all clients
    topic VARCHAR(255) NOT NULL,  -- Topic pattern (supports wildcards: +, #)
    access INTEGER NOT NULL,  -- 1=read (subscribe), 2=write (publish), 3=read+write
    priority INTEGER DEFAULT 0,  -- Higher priority rules override lower (for conflict resolution)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT valid_access CHECK (access IN (1, 2, 3))
);
CREATE INDEX idx_mqtt_acls_username ON mqtt_acls(username);
CREATE INDEX idx_mqtt_acls_clientid ON mqtt_acls(clientid);
CREATE INDEX idx_mqtt_acls_topic ON mqtt_acls(topic);
CREATE INDEX idx_mqtt_acls_priority ON mqtt_acls(priority DESC);
-- Link devices to MQTT users (one-to-one mapping)
-- This allows us to manage device MQTT credentials alongside device provisioning
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_username VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_client_id VARCHAR(255);
CREATE INDEX idx_devices_mqtt_username ON devices(mqtt_username);
-- Link dashboard users to MQTT users (optional - for users who need MQTT access)
ALTER TABLE users ADD COLUMN IF NOT EXISTS mqtt_username VARCHAR(255);
CREATE INDEX idx_users_mqtt_username ON users(mqtt_username);

-- ============================================================================
-- NOTE: Initial user/admin data is created by postgres-init-job.yaml
-- This ensures each customer gets unique credentials instead of hardcoded ones
-- ============================================================================

