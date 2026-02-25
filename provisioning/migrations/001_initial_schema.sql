-- Billing API Database Schema
-- PostgreSQL

-- Customers table
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    customer_id VARCHAR(100) UNIQUE NOT NULL,  -- e.g., cust_uuid
    email VARCHAR(255) UNIQUE NOT NULL,
    company_name VARCHAR(255),
    stripe_customer_id VARCHAR(100) UNIQUE,    -- Stripe customer ID
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_stripe ON customers(stripe_customer_id);

-- Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    customer_id VARCHAR(100) UNIQUE NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    stripe_subscription_id VARCHAR(100) UNIQUE,  -- Stripe subscription ID (NULL for trials)
    plan VARCHAR(50) NOT NULL DEFAULT 'starter', -- starter, professional, enterprise
    status VARCHAR(50) NOT NULL DEFAULT 'trialing', -- trialing, active, past_due, canceled, unpaid
    trial_ends_at TIMESTAMP,
    current_period_ends_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_subscriptions_customer ON subscriptions(customer_id);
CREATE INDEX idx_subscriptions_stripe ON subscriptions(stripe_subscription_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

-- Usage reports table (from customer instances)
CREATE TABLE IF NOT EXISTS usage_reports (
    id SERIAL PRIMARY KEY,
    customer_id VARCHAR(100) NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
    instance_id VARCHAR(100) NOT NULL DEFAULT 'default',
    active_devices INTEGER DEFAULT 0,
    total_devices INTEGER DEFAULT 0,
    reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_usage_customer ON usage_reports(customer_id);
CREATE INDEX idx_usage_reported_at ON usage_reports(reported_at);

-- Update timestamp trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to customers
CREATE TRIGGER update_customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Apply trigger to subscriptions
CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
