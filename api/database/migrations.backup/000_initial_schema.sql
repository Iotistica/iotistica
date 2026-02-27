-- Iotistic Cloud API - PostgreSQL Database Schema
-- Inspired by Balena Cloud architecture

-- Note: PostgreSQL 13+ has built-in gen_random_uuid() - no extension needed
-- Azure PostgreSQL blocks uuid-ossp extension

-- Devices table - stores device metadata
CREATE TABLE IF NOT EXISTS devices (
    id SERIAL PRIMARY KEY,
    uuid UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    device_name VARCHAR(255),
    device_type VARCHAR(100),
    is_online BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    last_connectivity_event TIMESTAMP,
    last_vpn_event TIMESTAMP,
    ip_address INET,
    mac_address VARCHAR(17),
    os_version VARCHAR(100),
    supervisor_version VARCHAR(100),
    api_heartbeat_state VARCHAR(50) DEFAULT 'online',
    memory_usage BIGINT,
    memory_total BIGINT,
    storage_usage BIGINT,
    storage_total BIGINT,
    cpu_usage DECIMAL(5,2),
    cpu_temp DECIMAL(5,2),
    cpu_id VARCHAR(100),
    is_undervolted BOOLEAN DEFAULT false,
    provisioning_progress INTEGER,
    provisioning_state VARCHAR(50),
    status VARCHAR(50) DEFAULT 'idle',
    download_progress INTEGER,
    logs_channel VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Device target state - what configuration the device should have
CREATE TABLE IF NOT EXISTS device_target_state (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    apps JSONB NOT NULL DEFAULT '{}',
    config JSONB DEFAULT '{}',
    version INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(device_uuid)
);

-- Device current state - what the device currently reports
CREATE TABLE IF NOT EXISTS device_current_state (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    apps JSONB NOT NULL DEFAULT '{}',
    config JSONB DEFAULT '{}',
    system_info JSONB DEFAULT '{}',
    reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(device_uuid)
);

-- Applications - container applications that can be deployed
CREATE TABLE IF NOT EXISTS applications (
    id SERIAL PRIMARY KEY,
    app_name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    is_host BOOLEAN DEFAULT false,
    should_track_latest_release BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Releases - versions of applications
CREATE TABLE IF NOT EXISTS releases (
    id SERIAL PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    commit VARCHAR(255) NOT NULL,
    composition JSONB NOT NULL,
    status VARCHAR(50) DEFAULT 'success',
    source VARCHAR(255),
    build_log TEXT,
    is_invalidated BOOLEAN DEFAULT false,
    start_timestamp TIMESTAMP,
    end_timestamp TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Device services - running services on devices
CREATE TABLE IF NOT EXISTS device_services (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    service_name VARCHAR(255) NOT NULL,
    image_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'Running',
    install_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(device_uuid, service_name)
);

-- Device logs - stores device and service logs
CREATE TABLE IF NOT EXISTS device_logs (
    id BIGSERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    service_name VARCHAR(255),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    message TEXT NOT NULL,
    is_system BOOLEAN DEFAULT false,
    is_stderr BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Device metrics - time-series metrics data
CREATE TABLE IF NOT EXISTS device_metrics (
    id BIGSERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    cpu_usage DECIMAL(5,2),
    cpu_temp DECIMAL(5,2),
    memory_usage BIGINT,
    memory_total BIGINT,
    storage_usage BIGINT,
    storage_total BIGINT,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Device environment variables
CREATE TABLE IF NOT EXISTS device_environment_variable (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    value TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(device_uuid, name)
);

-- API keys for authentication
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    key VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_devices_uuid ON devices(uuid);
CREATE INDEX idx_devices_is_online ON devices(is_online);
CREATE INDEX idx_devices_is_active ON devices(is_active);
CREATE INDEX idx_device_target_state_device_uuid ON device_target_state(device_uuid);
CREATE INDEX idx_device_current_state_device_uuid ON device_current_state(device_uuid);
CREATE INDEX idx_device_services_device_uuid ON device_services(device_uuid);
CREATE INDEX idx_device_logs_device_uuid ON device_logs(device_uuid);
CREATE INDEX idx_device_logs_timestamp ON device_logs(timestamp);
CREATE INDEX idx_device_metrics_device_uuid ON device_metrics(device_uuid);
CREATE INDEX idx_device_metrics_recorded_at ON device_metrics(recorded_at);
CREATE INDEX idx_releases_application_id ON releases(application_id);

-- Trigger to update modified_at timestamp
CREATE OR REPLACE FUNCTION update_modified_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.modified_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_devices_modified_at BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION update_modified_at_column();

CREATE TRIGGER update_applications_modified_at BEFORE UPDATE ON applications
    FOR EACH ROW EXECUTE FUNCTION update_modified_at_column();

CREATE TRIGGER update_releases_modified_at BEFORE UPDATE ON releases
    FOR EACH ROW EXECUTE FUNCTION update_modified_at_column();

CREATE TRIGGER update_device_services_modified_at BEFORE UPDATE ON device_services
    FOR EACH ROW EXECUTE FUNCTION update_modified_at_column();

CREATE TRIGGER update_device_environment_variable_modified_at BEFORE UPDATE ON device_environment_variable
    FOR EACH ROW EXECUTE FUNCTION update_modified_at_column();
