#!/bin/bash
set -e

# Iotistic Agent - Unified Installation Script
# Version: AGENT_VERSION_PLACEHOLDER
# This script installs the Iotistic agent using either Docker or Systemd
# Usage: curl -sfL https://apps.iotistic.ca/agent/install | sh
#
# Environment Variables (CI/Non-interactive mode):
#   IOTISTIC_INSTALL_METHOD       - Installation method: 'docker' or 'systemd' (auto-detect if not set)
#   IOTISTIC_AGENT_VERSION        - Agent version to install (default: latest for Docker, dev for Systemd)
#   IOTISTIC_DEVICE_PORT          - Device API port (default: 48484)
#   IOTISTIC_CLOUD_API_ENDPOINT   - Cloud API endpoint (e.g., https://api.iotistic.ca)
#   IOTISTIC_PROVISIONING_KEY     - Provisioning API key (leave empty for local mode)

SCRIPT_VERSION="AGENT_VERSION_PLACEHOLDER"

echo "=================================="
echo "Iotistic Agent Installer"
echo "Version: $SCRIPT_VERSION"
echo "=================================="
echo ""


# Check if running as root
if [ "$(id -u)" -ne 0 ]; then 
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    OS_VERSION=$VERSION_ID
else
    echo "Error: Cannot detect OS"
    exit 1
fi

echo "Detected OS: $OS $OS_VERSION"

# Determine installation method
INSTALL_METHOD="${IOTISTIC_INSTALL_METHOD:-}"

if [ -z "$INSTALL_METHOD" ]; then
    # Auto-detect or prompt
    if [ -n "$CI" ] || [ ! -t 0 ]; then
        # Non-interactive mode - auto-detect
        echo ""
        echo "Auto-detecting installation method..."
        if command -v docker &> /dev/null; then
            INSTALL_METHOD="docker"
            echo "✓ Docker found - using Docker installation"
        else
            INSTALL_METHOD="systemd"
            echo "⚠ Docker not found - using Systemd installation"
        fi
    else
        # Interactive mode - ask user
        echo ""
        echo "Choose installation method:"
        echo "  1) Docker container (recommended - easier updates, isolated environment)"
        echo "  2) Systemd service (native - lower overhead, more control)"
        echo ""
        read -p "Enter choice [1]: " choice
        choice=${choice:-1}
        
        case $choice in
            1)
                INSTALL_METHOD="docker"
                ;;
            2)
                INSTALL_METHOD="systemd"
                ;;
            *)
                echo "Invalid choice. Using Docker (default)"
                INSTALL_METHOD="docker"
                ;;
        esac
    fi
fi

echo ""
echo "Installation method: $INSTALL_METHOD"
echo ""

# ============================================================================
# DOCKER INSTALLATION
# ============================================================================
if [ "$INSTALL_METHOD" = "docker" ]; then
    echo "==================================="
    echo "Docker Installation"
    echo "==================================="
    echo ""

    # Check if Docker is installed
    if ! command -v docker &> /dev/null; then
        echo "⚠️  Docker is not installed on this system."
        echo ""
        
        # Check if running in non-interactive mode
        if [ -n "$CI" ] || [ ! -t 0 ]; then
            echo "Running in non-interactive mode - Docker will be installed automatically."
            INSTALL_DOCKER="yes"
        else
            # Interactive mode - ask user
            read -p "Would you like to install Docker now? (yes/no): " INSTALL_DOCKER
        fi
        
        if [ "$INSTALL_DOCKER" = "yes" ] || [ "$INSTALL_DOCKER" = "y" ]; then
            echo "Installing Docker..."
            curl -fsSL https://get.docker.com -o get-docker.sh
            sh get-docker.sh
            rm get-docker.sh
            
            # Start and enable Docker
            systemctl start docker
            systemctl enable docker
            
            echo "✓ Docker installed successfully"
        else
            echo ""
            echo "Error: Docker is required for this installation method."
            echo "Please install Docker manually or choose Systemd installation."
            echo ""
            echo "To install Docker, run:"
            echo "  curl -fsSL https://get.docker.com | sh"
            exit 1
        fi
    else
        echo "✓ Docker is already installed ($(docker --version))"
    fi

    # Verify Docker daemon is accessible
    if ! docker ps &> /dev/null; then
        echo ""
        echo "⚠️  Docker is installed but the daemon is not accessible."
        
        # Check if Docker daemon is running
        if ! systemctl is-active --quiet docker 2>/dev/null; then
            echo "Starting Docker daemon..."
            systemctl start docker
            sleep 3
        fi
        
        # Try again
        if ! docker ps &> /dev/null; then
            echo "✗ Error: Cannot connect to Docker daemon"
            echo ""
            echo "Possible causes:"
            echo "  1. Docker daemon is not running: sudo systemctl start docker"
            echo "  2. Permission denied: Add your user to docker group: sudo usermod -aG docker \$USER"
            echo "  3. Docker socket not accessible: Check /var/run/docker.sock permissions"
            exit 1
        fi
    fi

    echo "✓ Docker is ready"

    # Create directories
    echo ""
    echo "Creating directories..."
    mkdir -p /var/lib/iotistic/agent
    mkdir -p /var/log/iotistic

    # Configuration
    echo ""
    echo "Configuration:"
    echo "-------------"

    # Check if running in non-interactive mode
    if [ -n "$CI" ]; then
        echo "Running in CI mode (non-interactive)"
        PROVISIONING_KEY="${PROVISIONING_KEY:-}"
        DEVICE_API_PORT="${IOTISTIC_DEVICE_PORT:-48484}"
        AGENT_VERSION="${IOTISTIC_AGENT_VERSION:-latest}"
        CLOUD_API_ENDPOINT="${CLOUD_API_ENDPOINT:-}"
    elif [ ! -t 0 ] && [ -z "$FORCE_INTERACTIVE" ]; then
        echo "Running in non-interactive mode (stdin is not a terminal)"
        echo "Using default/environment variable configuration"
        PROVISIONING_KEY="${PROVISIONING_KEY:-}"
        DEVICE_API_PORT="${IOTISTIC_DEVICE_PORT:-48484}"
        AGENT_VERSION="${IOTISTIC_AGENT_VERSION:-latest}"
        CLOUD_API_ENDPOINT="${CLOUD_API_ENDPOINT:-}"
    else
        # Interactive mode - prompt user
        read -p "Enter cloud API endpoint (leave empty for local mode): " CLOUD_API_ENDPOINT
        read -p "Enter provisioning API key (leave empty for local mode): " PROVISIONING_KEY
        read -p "Enter device API port [48484]: " DEVICE_API_PORT
        DEVICE_API_PORT=${DEVICE_API_PORT:-48484}
        
        echo ""
        echo "Fetching latest agent version..."
        LATEST_VERSION=$(curl -s https://registry.hub.docker.com/v2/repositories/iotistic/agent/tags | jq -r '.results[].name' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
        if [ -z "$LATEST_VERSION" ]; then
            LATEST_VERSION="latest"
        fi
        AGENT_VERSION="$LATEST_VERSION"
        echo "Using version: $AGENT_VERSION"
    fi

    # Pull the image
    echo ""
    echo "Pulling Docker image..."
    docker pull iotistic/agent:$AGENT_VERSION

    # Stop and remove existing container if it exists
    if docker ps -a | grep -q iotistic-agent; then
        echo "Stopping existing agent container..."
        docker stop iotistic-agent || true
        docker rm iotistic-agent || true
    fi

    # Create and start container
    echo ""
    echo "Starting agent container..."

    # Build environment variables
    ENV_VARS="-e DEVICE_API_PORT=48484 \
        -e AGENT_VERSION=${AGENT_VERSION} \
        -e NODE_ENV=production \
        -e LOG_LEVEL=info \
        -e ORCHESTRATOR_TYPE=docker-compose \
        -e ORCHESTRATOR_INTERVAL=30000"

    if [ -n "$PROVISIONING_KEY" ]; then
        ENV_VARS="$ENV_VARS -e PROVISIONING_KEY=${PROVISIONING_KEY}"
    fi

    if [ -n "$CLOUD_API_ENDPOINT" ]; then
        ENV_VARS="$ENV_VARS -e CLOUD_API_ENDPOINT=${CLOUD_API_ENDPOINT}"
    fi

    docker run -d \
        --name iotistic-agent \
        --restart unless-stopped \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v /var/lib/iotistic/agent:/app/data \
        -p ${DEVICE_API_PORT}:48484 \
        $ENV_VARS \
        iotistic/agent:$AGENT_VERSION

    # Wait for container to start
    echo "Waiting for agent to start..."
    sleep 10

    # Check if container is running
    if docker ps | grep -q iotistic-agent; then
        echo ""
        echo "✓ Agent container is running"
        
        echo ""
        echo "Recent logs:"
        echo "------------"
        docker logs --tail=20 iotistic-agent
        
        echo ""
        echo "=================================="
        echo "Installation complete!"
        echo "=================================="
        echo ""
        echo "Agent is running as Docker container 'iotistic-agent'"
        echo "Device API: http://localhost:${DEVICE_API_PORT}"
        echo ""
        echo "Useful commands:"
        echo "  docker logs -f iotistic-agent          # View logs"
        echo "  docker restart iotistic-agent          # Restart agent"
        echo "  docker stop iotistic-agent             # Stop agent"
        echo "  docker start iotistic-agent            # Start agent"
        echo ""
    else
        echo ""
        echo "✗ Error: Agent container failed to start"
        echo ""
        echo "Container logs:"
        docker logs iotistic-agent
        exit 1
    fi

# ============================================================================
# SYSTEMD INSTALLATION
# ============================================================================
elif [ "$INSTALL_METHOD" = "systemd" ]; then
    echo "==================================="
    echo "Systemd Installation"
    echo "==================================="
    echo ""

    # Check if systemd is available
    if ! command -v systemctl &> /dev/null; then
        echo "Error: systemd is not available on this system"
        echo "Please use the Docker installation method instead"
        exit 1
    fi

    # Install system dependencies
    echo "Installing system dependencies..."
    apt-get update
    apt-get install -y \
        curl wget git build-essential python3 make g++ \
        sqlite3 libsqlite3-dev jq procps \
        openvpn wireguard wireguard-tools \
        iproute2 iptables net-tools iputils-ping

    echo "✓ System dependencies installed"

    # Install Docker (required for agent functionality)
    if ! command -v docker &> /dev/null; then
        echo ""
        echo "Installing Docker..."
        curl -fsSL https://get.docker.com -o get-docker.sh
        sh get-docker.sh
        rm get-docker.sh
        
        systemctl start docker
        systemctl enable docker
        
        echo "✓ Docker installed successfully"
    else
        echo "✓ Docker is already installed"
    fi

    # Install Node.js 20
    if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
        echo ""
        echo "Installing Node.js 20..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
        echo "✓ Node.js installed successfully"
    else
        echo "✓ Node.js is already installed ($(node --version))"
    fi

    # Create iotistic user
    if ! id -u iotistic &> /dev/null; then
        echo ""
        echo "Creating iotistic user..."
        useradd --system --home-dir /opt/iotistic --shell /bin/bash iotistic
        usermod -aG docker iotistic
        echo "✓ User created and added to docker group"
    else
        echo "✓ User iotistic already exists"
    fi

    # Create directories
    echo ""
    echo "Creating directories..."
    mkdir -p /opt/iotistic/agent
    mkdir -p /etc/iotistic
    mkdir -p /var/lib/iotistic/agent
    mkdir -p /var/log/iotistic

    # Configuration
    echo ""
    echo "Configuration:"
    echo "-------------"

    if [ -n "$CI" ] || [ ! -t 0 ]; then
        echo "Running in non-interactive mode"
        if [ -n "$PROVISIONING_KEY" ]; then
            echo "[DEBUG] PROVISIONING_KEY found in environment (redacted)"
        fi
        DEVICE_API_PORT="${IOTISTIC_DEVICE_PORT:-48484}"
        AGENT_VERSION="${IOTISTIC_AGENT_VERSION:-dev}"
        CLOUD_API_ENDPOINT="${CLOUD_API_ENDPOINT:-}"
        
        echo "Using current repository code (CI mode)"
    else
        # Interactive mode
        read -p "Enter cloud API endpoint (leave empty for local mode): " CLOUD_API_ENDPOINT
        read -p "Enter provisioning API key (leave empty for local mode): " PROVISIONING_KEY
        read -p "Enter device API port [48484]: " DEVICE_API_PORT
        DEVICE_API_PORT=${DEVICE_API_PORT:-48484}

        echo ""
        echo "Downloading latest agent release..."
        LATEST_TAG=$(curl -s https://api.github.com/repos/Iotistica/iotistic/releases/latest | jq -r '.tag_name')
        if [ -z "$LATEST_TAG" ] || [ "$LATEST_TAG" = "null" ]; then
            echo "Warning: Could not fetch latest release, cloning master branch..."
            cd /tmp
            rm -rf iotistic-agent-temp
            git clone --depth 1 https://github.com/Iotistica/iotistic.git iotistic-agent-temp
            cp -r iotistic-agent-temp/agent/* /opt/iotistic/agent/
            mkdir -p /opt/iotistic/config
            cp -r iotistic-agent-temp/config/* /opt/iotistic/config/
            rm -rf iotistic-agent-temp
            AGENT_VERSION="dev"
        else
            echo "Latest release: $LATEST_TAG"
            cd /tmp
            rm -rf iotistic-agent-temp
            wget -q https://github.com/Iotistica/iotistic/archive/refs/tags/${LATEST_TAG}.tar.gz
            tar -xzf ${LATEST_TAG}.tar.gz
            cp -r iotistic-${LATEST_TAG#v}/agent/* /opt/iotistic/agent/
            mkdir -p /opt/iotistic/config
            cp -r iotistic-${LATEST_TAG#v}/config/* /opt/iotistic/config/
            rm -rf iotistic-${LATEST_TAG#v} ${LATEST_TAG}.tar.gz
            AGENT_VERSION="${LATEST_TAG#v}"
        fi
    fi

    # Build agent
    echo ""
    echo "Installing agent dependencies..."
    cd /opt/iotistic/agent
    npm ci --legacy-peer-deps

    echo "Building agent..."
    npx tsc --project tsconfig.build.json
    
    echo "Copying migrations..."
    npm run copy:migrations
    if [ ! -d dist/db/migrations ]; then
        echo "✗ Error: Migrations copy failed - dist/db/migrations not found"
        exit 1
    fi

    if [ ! -f dist/app.js ]; then
        echo "✗ Error: Build failed - dist/app.js not found"
        exit 1
    fi
    echo "✓ Agent built successfully"

    # Install update script
    if [ -f /opt/iotistic/agent/bin/update-agent-systemd.sh ]; then
        echo ""
        echo "Installing update script..."
        cp /opt/iotistic/agent/bin/update-agent-systemd.sh /usr/local/bin/update-agent-systemd.sh
        chmod +x /usr/local/bin/update-agent-systemd.sh
        echo "✓ Update script installed"
    fi

    # Create environment file
    echo ""
    echo "Creating environment file..."
    
    # Generate device UUID if not already set
    if [ ! -f /var/lib/iotistic/agent/device-uuid ]; then
        DEVICE_UUID=$(cat /proc/sys/kernel/random/uuid)
        echo "$DEVICE_UUID" > /var/lib/iotistic/agent/device-uuid
    else
        DEVICE_UUID=$(cat /var/lib/iotistic/agent/device-uuid)
    fi
    
    cat > /etc/iotistic/agent.env << EOF
AGENT_VERSION=${AGENT_VERSION}
DEVICE_API_PORT=${DEVICE_API_PORT}
DEVICE_UUID=${DEVICE_UUID}
NODE_ENV=production
LOG_LEVEL=info
ORCHESTRATOR_TYPE=docker-compose
ORCHESTRATOR_INTERVAL=30000
STATE_FILE=/var/lib/iotistic/agent/target-state.json
DATABASE_PATH=/var/lib/iotistic/agent/device.sqlite
EOF

    if [ -n "$PROVISIONING_KEY" ]; then
        echo "[DEBUG] Writing PROVISIONING_KEY to agent.env (redacted)"
        echo "PROVISIONING_KEY=${PROVISIONING_KEY}" >> /etc/iotistic/agent.env
    else
        echo "[DEBUG] PROVISIONING_KEY is empty, not writing to agent.env"
    fi

    if [ -n "$CLOUD_API_ENDPOINT" ]; then
        echo "CLOUD_API_ENDPOINT=${CLOUD_API_ENDPOINT}" >> /etc/iotistic/agent.env
    fi

    # Add MQTT broker configuration if provided
    if [ -n "$MQTT_BROKER_HOST" ]; then
        echo "MQTT_BROKER_HOST=${MQTT_BROKER_HOST}" >> /etc/iotistic/agent.env
    fi
    
    if [ -n "$MQTT_BROKER_PORT" ]; then
        echo "MQTT_BROKER_PORT=${MQTT_BROKER_PORT}" >> /etc/iotistic/agent.env
    fi
    
    if [ -n "$MQTT_USE_TLS" ]; then
        echo "MQTT_USE_TLS=${MQTT_USE_TLS}" >> /etc/iotistic/agent.env
    fi

    # Set permissions
    echo ""
    echo "Setting permissions..."
    chown -R iotistic:iotistic /opt/iotistic/agent
    chown -R iotistic:iotistic /var/lib/iotistic/agent
    chown -R iotistic:iotistic /var/log/iotistic
    chown iotistic:iotistic /etc/iotistic/agent.env
    chmod 600 /etc/iotistic/agent.env

    # Create systemd service
    echo ""
    echo "Creating systemd service..."

    NODE_PATH=$(which node)

    echo "Node path: ${NODE_PATH}"
    
    cat > /etc/systemd/system/iotistic-agent.service << EOFSVC
[Unit]
Description=Iotistic Agent - IoT Device Management Service
Documentation=https://github.com/Iotistica/iotistic
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=iotistic
Group=iotistic
WorkingDirectory=/opt/iotistic/agent
EnvironmentFile=/etc/iotistic/agent.env
Environment=NODE_ENV=production

ExecStart=$NODE_PATH /opt/iotistic/agent/dist/app.js

Restart=always
RestartSec=10

StandardOutput=journal
StandardError=journal
SyslogIdentifier=iotistic-agent

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/iotistic /var/log/iotistic /opt/iotistic/agent
CapabilityBoundingSet=
LockPersonality=true
MemoryAccounting=true
CPUAccounting=true

# Resource limits
LimitNOFILE=65536
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOFSVC

    # Configure journald limits (prevent disk exhaustion on edge devices)
    echo ""
    echo "Configuring journald log limits..."
    
    # Backup existing config if it exists
    if [ -f /etc/systemd/journald.conf ]; then
        cp /etc/systemd/journald.conf /etc/systemd/journald.conf.bak.$(date +%s)
    fi
    
    # Set bounded log storage for edge devices
    cat > /etc/systemd/journald.conf << EOFJOURNALD
[Journal]
# Disk storage limits (important for edge devices)
SystemMaxUse=200M
RuntimeMaxUse=100M
MaxRetentionSec=7day

# Keep logs structured and compressed
Compress=yes
Storage=persistent

# Forward to syslog if needed
ForwardToSyslog=no
ForwardToKMsg=no
ForwardToConsole=no
EOFJOURNALD

    # Restart journald to apply limits
    systemctl restart systemd-journald
    echo "✓ Journald limits configured (200M disk, 7 day retention)"

    # Verify agent.env permissions before starting service
    echo ""
    echo "Verifying configuration file permissions..."
    if [ "$(stat -c %a /etc/iotistic/agent.env)" != "600" ]; then
        echo "✗ Error: agent.env permissions are insecure"
        echo "Expected: 600, Found: $(stat -c %a /etc/iotistic/agent.env)"
        exit 1
    fi
    echo "✓ Configuration file permissions verified (600)"

    # Start service
    systemctl daemon-reload
    echo ""
    echo "Starting agent service..."
    systemctl enable iotistic-agent
    systemctl start iotistic-agent

    sleep 10

    if systemctl is-active --quiet iotistic-agent; then
        echo ""
        echo "✓ Agent service is running"
        
        echo ""
        echo "Recent logs:"
        journalctl -u iotistic-agent -n 50 --no-pager
        
        echo ""
        echo "====================================="
        echo "Installation complete!"
        echo "====================================="
        echo ""
        echo "Agent is running as systemd service 'iotistic-agent'"
        echo "Device API: http://localhost:${DEVICE_API_PORT}"
        echo ""
        echo "Useful commands:"
        echo "  systemctl status iotistic-agent        # Check status"
        echo "  journalctl -u iotistic-agent -f        # View logs"
        echo "  systemctl restart iotistic-agent       # Restart agent"
        echo "  systemctl stop iotistic-agent          # Stop agent"
        echo ""
    else
        echo ""
        echo "✗ Error: Agent service failed to start"
        systemctl status iotistic-agent --no-pager
        journalctl -u iotistic-agent -n 50 --no-pager
        exit 1
    fi

else
    echo "Error: Invalid installation method: $INSTALL_METHOD"
    echo "Valid options: docker, systemd"
    exit 1
fi
