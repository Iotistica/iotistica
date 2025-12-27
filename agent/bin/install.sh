#!/bin/bash
set -e

# Iotistic Agent - Unified Installation Script
# Version: AGENT_VERSION_PLACEHOLDER
# This script installs the Iotistic agent using either Docker or Systemd
# Usage: curl -sfL https://apps.iotistica.com/agent/install | sh
#
# Environment Variables (CI/Non-interactive mode):
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

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        ARCH_NAME="x86_64"
        ;;
    aarch64|arm64)
        ARCH_NAME="arm64"
        ;;
    armv7l|armhf)
        ARCH_NAME="armhf"
        ;;
    *)
        echo "Warning: Unknown architecture $ARCH, continuing anyway..."
        ARCH_NAME="$ARCH"
        ;;
esac

echo "Detected OS: $OS $OS_VERSION ($ARCH_NAME)"

# Helper function to install Docker if needed
install_docker_if_needed() {
    local REQUIRE_INSTALL="${1:-no}"  # 'yes' = install without asking, 'no' = ask in interactive mode
    
    if command -v docker &> /dev/null; then
        echo "✓ Docker is already installed ($(docker --version))"
        return 0
    fi
    
    echo "⚠️  Docker is not installed on this system."
    echo ""
    
    # Determine if we should install
    local SHOULD_INSTALL="$REQUIRE_INSTALL"
    if [ "$SHOULD_INSTALL" != "yes" ]; then
        if [ -n "$CI" ] || [ ! -t 0 ]; then
            echo "Running in non-interactive mode - Docker will be installed automatically."
            SHOULD_INSTALL="yes"
        else
            read -p "Would you like to install Docker now? (yes/no): " SHOULD_INSTALL
        fi
    fi
    
    if [ "$SHOULD_INSTALL" = "yes" ] || [ "$SHOULD_INSTALL" = "y" ]; then
        echo "Installing Docker..."
        curl -fsSL https://get.docker.com -o get-docker.sh
        sh get-docker.sh
        rm get-docker.sh
        
        systemctl start docker
        systemctl enable docker
        
        echo "✓ Docker installed successfully"
        return 0
    else
        echo ""
        echo "Error: Docker is required for this installation method."
        echo "Please install Docker manually or choose Systemd installation."
        echo ""
        echo "To install Docker, run:"
        echo "  curl -fsSL https://get.docker.com | sh"
        return 1
    fi
}

echo ""
echo "Installation method: Systemd + Docker"
echo ""

# ============================================================================
# SYSTEMD INSTALLATION
# ============================================================================
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
    
    # Fix multiarch configuration issues on Raspberry Pi
    # Remove foreign architectures that may cause conflicts
    if [ "$ARCH_NAME" = "arm64" ]; then
        echo "Cleaning up multiarch configuration for arm64..."
        # Remove armhf architecture if present
        if dpkg --print-foreign-architectures | grep -q armhf; then
            # First try to remove conflicting packages
            apt-get remove --purge -y '*:armhf' 2>/dev/null || true
            dpkg --remove-architecture armhf 2>/dev/null || true
        fi
        dpkg --remove-architecture i386 2>/dev/null || true
    elif [ "$ARCH_NAME" = "armhf" ]; then
        echo "Cleaning up multiarch configuration for armhf..."
        if dpkg --print-foreign-architectures | grep -q arm64; then
            apt-get remove --purge -y '*:arm64' 2>/dev/null || true
            dpkg --remove-architecture arm64 2>/dev/null || true
        fi
        dpkg --remove-architecture i386 2>/dev/null || true
    fi
    
    # Clean up package cache and fix broken dependencies
    apt-get clean
    apt-get autoclean
    dpkg --configure -a 2>/dev/null || true
    
    # Update package lists
    apt-get update || {
        echo "Warning: apt-get update failed, continuing anyway..."
    }
    
    # Install essential dependencies first (these should always work)
    apt-get install -y --no-install-recommends \
        curl wget git build-essential python3 make g++ || {
        echo "Error: Failed to install essential build tools"
        exit 1
    }
    
    # Install database and utilities (skip if fails due to architecture issues)
    apt-get install -y --no-install-recommends \
        sqlite3 libsqlite3-dev jq procps 2>/dev/null || {
        echo "Warning: Some database packages failed to install, continuing..."
    }
    
    
    # Install networking tools
    apt-get install -y --no-install-recommends \
        iproute2 iptables net-tools iputils-ping || {
        echo "Warning: Some network tools failed to install"
    }

    echo "✓ System dependencies installed"

    # Install Docker (required for agent functionality)
    echo ""
    install_docker_if_needed "yes"

    # Install Node.js 20 (or accept existing Node 18+)
    if ! command -v node &> /dev/null; then
        echo ""
        echo "Installing Node.js 20..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
        echo "✓ Node.js installed successfully"
    else
        NODE_MAJOR_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_MAJOR_VERSION" -lt 18 ]; then
            echo ""
            echo "Upgrading Node.js to version 20..."
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
            apt-get install -y nodejs
            echo "✓ Node.js upgraded successfully"
        else
            echo "✓ Node.js is already installed ($(node --version)) - version 18+ is compatible"
        fi
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

    # Detect if we're running from a checked-out repository FIRST
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    AGENT_DIR="$(dirname "$SCRIPT_DIR")"
    
    # Check if running interactively (has terminal and not CI)
    if [ -t 0 ] && [ -z "$CI" ]; then
        echo "Running in interactive mode"
        
        #Prompt for configuration
        read -p "Enter cloud API endpoint (leave empty for local mode): " CLOUD_API_ENDPOINT
        read -p "Enter provisioning API key (leave empty for local mode): " PROVISIONING_KEY
        read -p "Enter device API port [48484]: " DEVICE_API_PORT
        DEVICE_API_PORT=${DEVICE_API_PORT:-48484}
        AGENT_VERSION="dev"
    else
        echo "Running in non-interactive mode"
        
        if [ -n "$PROVISIONING_KEY" ]; then
            echo "[DEBUG] PROVISIONING_KEY found in environment (redacted)"
        fi
        DEVICE_API_PORT="${IOTISTIC_DEVICE_PORT:-48484}"
        AGENT_VERSION="${IOTISTIC_AGENT_VERSION:-dev}"
        CLOUD_API_ENDPOINT="${CLOUD_API_ENDPOINT:-}"
    fi
    
    # Now handle repository access (works for both modes)
    if [ -f "$AGENT_DIR/package.json" ]; then
        echo "Using current repository checkout from: $AGENT_DIR"
        
        # Copy agent code
        echo "Copying agent code..."
        cp -r "$AGENT_DIR"/* /opt/iotistic/agent/
        
        echo "✓ Repository code copied to /opt/iotistic/agent"
    else
        # Download pre-built agent from public distribution server
        echo "Downloading agent from distribution server..."
        
        # Use custom download URL if provided, otherwise use default
        DOWNLOAD_URL="${IOTISTIC_DOWNLOAD_URL:-https://downloads.iotistica.com/agent/${AGENT_VERSION}.tar.gz}"
        
        cd /tmp
        rm -rf iotistic-agent-download
        
        echo "Downloading from: $DOWNLOAD_URL"
        
        # Try to download with curl or wget
        if command -v curl &> /dev/null; then
            curl -fSL -o agent.tar.gz "$DOWNLOAD_URL" || DOWNLOAD_FAILED=1
        elif command -v wget &> /dev/null; then
            wget -O agent.tar.gz "$DOWNLOAD_URL" || DOWNLOAD_FAILED=1
        else
            echo "Error: Neither curl nor wget is available"
            exit 1
        fi
        
        if [ "$DOWNLOAD_FAILED" = "1" ]; then
            echo ""
            echo "Error: Failed to download agent from distribution server"
            echo ""
            echo "Troubleshooting:"
            echo "  1. Check your internet connection"
            echo "  2. Verify the download URL: $DOWNLOAD_URL"
            echo ""
            echo "For development/internal installations:"
            echo "  Run this script from within a cloned repository:"
            echo "    git clone https://github.com/Iotistica/iotistic.git"
            echo "    cd iotistic/agent/bin"
            echo "    sudo ./install.sh"
            exit 1
        fi
        
        echo "Extracting agent..."
        mkdir -p iotistic-agent-download
        tar -xzf agent.tar.gz -C iotistic-agent-download || {
            echo "Error: Failed to extract agent tarball"
            exit 1
        }
        
        # Copy extracted files to installation directory
        cp -r iotistic-agent-download/* /opt/iotistic/agent/ || {
            echo "Error: Failed to copy agent files"
            exit 1
        }
        
        # Cleanup
        rm -rf iotistic-agent-download agent.tar.gz
        
        echo "✓ Agent downloaded and installed"
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
Environment=DEPLOYMENT_TYPE=systemd

ExecStart=$NODE_PATH /opt/iotistic/agent/dist/app.js

Restart=always
RestartSec=10
WatchdogSec=30

StandardOutput=journal
StandardError=journal
SyslogIdentifier=iotistic-agent

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/iotistic /var/log/iotistic /opt/iotistic/agent /var/run/docker.sock
CapabilityBoundingSet=
LockPersonality=true
MemoryAccounting=true
CPUAccounting=true

# Resource limits
LimitNOFILE=65536
LimitNPROC=65536
MemoryMax=1G
TasksMax=infinity

[Install]
WantedBy=multi-user.target
EOFSVC

    # Configure journald limits (prevent disk exhaustion on edge devices)
    echo ""
    echo "Configuring journald log limits..."
    
    # Use drop-in config instead of overwriting system file
    mkdir -p /etc/systemd/journald.conf.d
    
    cat > /etc/systemd/journald.conf.d/iotistic.conf << EOFJOURNALD
[Journal]
# Disk storage limits (important for edge devices)
SystemMaxUse=200M
RuntimeMaxUse=100M
MaxRetentionSec=7day

# Keep logs structured and compressed
Compress=yes
Storage=persistent
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
