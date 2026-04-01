#!/bin/bash
# Core integration tests environment configuration.
# This script creates the .env file used by docker-compose.e2e.yml.

cat > .env << EOF
# PostgreSQL
POSTGRES_DB=iotistic
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres

# Redis
REDIS_PORT_EXT=6379
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_USERNAME=

# API
API_PORT_EXT=4002
PORT=3002
NODE_ENV=development
LOG_LEVEL=info
JWT_SECRET=integration-test-secret
AUTH0_ENABLED=false

# Database connection
DB_HOST=postgres
DB_PORT=5432
DB_NAME=iotistic
DB_USER=postgres
DB_PASSWORD=postgres
DB_POOL_SIZE=20
DB_SSL=false
DB_SSL_REJECT_UNAUTHORIZED=false

# Cloud MQTT broker address used by the API container inside docker-compose.e2e.yml
MQTT_BROKER_HOST=mosquitto
MQTT_BROKER_PORT=1883
MQTT_BROKER_PROTOCOL=mqtt
MQTT_BROKER_USE_TLS=false
MOSQUITTO_PORT_EXT=5883
MOSQUITTO_WS_PORT_EXT=59002
MQTT_USERNAME=admin
MQTT_PASSWORD=iotistic42!
MQTT_PERSIST_TO_DB=true
MQTT_DB_SYNC_INTERVAL=10000
MQTT_MONITOR_ENABLED=true

# License keys
LICENSE_PUBLIC_KEY=${LICENSE_PUBLIC_KEY}
IOTISTIC_LICENSE_KEY=${IOTISTIC_LICENSE_KEY}

# Logging
FORCE_COLOR=1
LOG_COMPRESSION=true
EOF

echo "✓ Core integration environment file created successfully"
