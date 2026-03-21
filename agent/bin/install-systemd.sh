#!/bin/bash
set -e

# Iotistic Agent - Systemd Installation Script
# Version: AGENT_VERSION_PLACEHOLDER
# This script installs the Iotistic agent as a native systemd service with PM2
# Usage: curl -sSL https://apps.iotistic.ca/agent/install-systemd.sh | bash
#
# Environment Variables (CI/Non-interactive mode):
#   IOTISTIC_AGENT_VERSION        - Agent version to install (default: dev)
#   IOTISTIC_DEVICE_PORT          - Device API port (default: 48484)
#   IOTISTIC_IOTISTICA_API   - Cloud API endpoint (e.g., https://api.iotistic.ca)
#   IOTISTIC_PROVISIONING_KEY     - Provisioning API key (leave empty for local mode)

SCRIPT_VERSION="AGENT_VERSION_PLACEHOLDER"

echo "====================================="
echo "Iotistic Agent - Systemd Installer"
echo "Version: $SCRIPT_VERSION"
echo "====================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
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

# Check if systemd is available
if ! command -v systemctl &> /dev/null; then
    echo "Error: systemd is not available on this system"
    echo "Please use the Docker installation method instead"
    exit 1
fi

# Install system dependencies
echo ""
echo "Installing system dependencies..."
apt-get update
apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    python3 \
    make \
    g++ \
    sqlite3 \
    libsqlite3-dev \
    jq \
    procps \
    openvpn \
    iproute2 \
    iptables \
    net-tools \
    iputils-ping

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

# Install Node.js 20 if not present
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 20 ]; then
    echo ""
    echo "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
    echo "✓ Node.js installed successfully"
else
    echo "✓ Node.js is already installed"
    node --version
fi

# Install PM2 globally
if ! command -v pm2 &> /dev/null; then
    echo ""
    echo "Installing PM2 process manager..."
    npm install -g pm2
    echo "✓ PM2 installed successfully"
else
    echo "✓ PM2 is already installed"
fi

# Create iotistic user if doesn't exist
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

# Prompt for configuration
echo ""
echo "Configuration:"
echo "-------------"

# Check if running in non-interactive mode (CI)
if [ -n "$CI" ] || [ ! -t 0 ]; then
    echo "Running in non-interactive mode (CI)"
    PROVISIONING_KEY="${IOTISTIC_PROVISIONING_KEY:-}"
    DEVICE_API_PORT="${IOTISTIC_DEVICE_PORT:-48484}"
    AGENT_VERSION="${IOTISTIC_AGENT_VERSION:-dev}"
    IOTISTICA_API="${IOTISTIC_IOTISTICA_API:-}"
    
    # In CI mode, skip downloading - use the current repository
    echo "Using current repository code (CI mode)"
else
    # Interactive mode - prompt user
    # Cloud API endpoint
    read -p "Enter cloud API endpoint (leave empty for local mode): " IOTISTICA_API
    
    # Provisioning key (optional)
    read -p "Enter provisioning API key (leave empty for local mode): " PROVISIONING_KEY

    # Agent port
    read -p "Enter device API port [48484]: " DEVICE_API_PORT
    DEVICE_API_PORT=${DEVICE_API_PORT:-48484}

    # Get latest agent release
    echo ""
    echo "Downloading latest agent release..."
    LATEST_TAG=$(curl -s https://api.github.com/repos/Iotistica/iotistic/releases/latest | jq -r '.tag_name')
    if [ -z "$LATEST_TAG" ] || [ "$LATEST_TAG" = "null" ]; then
        echo "Warning: Could not fetch latest release, cloning master branch..."
        cd /tmp
        rm -rf iotistic-agent-temp
        git clone --depth 1 https://github.com/Iotistica/iotistic.git iotistic-agent-temp
        cp -r iotistic-agent-temp/agent/* /opt/iotistic/agent/
        rm -rf iotistic-agent-temp
        AGENT_VERSION="dev"
    else
        echo "Latest release: $LATEST_TAG"
        cd /tmp
        rm -rf iotistic-agent-temp
        wget -q https://github.com/Iotistica/iotistic/archive/refs/tags/${LATEST_TAG}.tar.gz
        tar -xzf ${LATEST_TAG}.tar.gz
        cp -r iotistic-${LATEST_TAG#v}/agent/* /opt/iotistic/agent/
        rm -rf iotistic-${LATEST_TAG#v} ${LATEST_TAG}.tar.gz
        AGENT_VERSION="${LATEST_TAG#v}"
    fi
fi

# Install dependencies and build
echo ""
echo "Installing agent dependencies..."
cd /opt/iotistic/agent
npm ci --legacy-peer-deps

echo "Building agent..."
npx tsc --project tsconfig.build.json
npm run copy:migrations

# Verify build
if [ ! -f dist/app.js ]; then
    echo "✗ Error: Build failed - dist/app.js not found"
    exit 1
fi
echo "✓ Agent built successfully"

# Install update script
echo ""
echo "Installing update script..."
cp /opt/iotistic/agent/bin/update-agent-systemd.sh /usr/local/bin/update-agent-systemd.sh
chmod +x /usr/local/bin/update-agent-systemd.sh
echo "✓ Update script installed to /usr/local/bin/update-agent-systemd.sh"

# Create environment file
echo ""
echo "Creating environment file..."
cat > /etc/iotistic/agent.env << EOF
AGENT_VERSION=${AGENT_VERSION}
DEVICE_API_PORT=${DEVICE_API_PORT}
NODE_ENV=production
LOG_LEVEL=info
ORCHESTRATOR_TYPE=docker-compose
ORCHESTRATOR_INTERVAL=30000
STATE_FILE=/var/lib/iotistic/agent/target-state.json
EOF

# Add PROVISIONING_API_KEY if provided
if [ -n "$PROVISIONING_KEY" ]; then
    echo "PROVISIONING_API_KEY=${PROVISIONING_KEY}" >> /etc/iotistic/agent.env
fi

# Add IOTISTICA_API if provided
if [ -n "$IOTISTICA_API" ]; then
    echo "IOTISTICA_API=${IOTISTICA_API}" >> /etc/iotistic/agent.env
fi

# Create PM2 ecosystem config
echo ""
echo "Creating PM2 configuration..."
cat > /opt/iotistic/agent/ecosystem.config.js << 'EOFCONFIG'
module.exports = {
  apps: [{
    name: 'iotistic-agent',
    script: 'dist/app.js',
    cwd: '/opt/iotistic/agent',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env_file: '/etc/iotistic/agent.env',
    output: '/var/log/iotistic/agent-out.log',
    error: '/var/log/iotistic/agent-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
EOFCONFIG

# Set permissions
echo "Setting permissions..."
touch /var/log/iotistic/agent-out.log
touch /var/log/iotistic/agent-error.log
chown -R iotistic:iotistic /opt/iotistic/agent
chown -R iotistic:iotistic /var/lib/iotistic/agent
chown -R iotistic:iotistic /var/log/iotistic
chown iotistic:iotistic /etc/iotistic/agent.env
chmod 600 /etc/iotistic/agent.env

# Create systemd service file
echo ""
echo "Creating systemd service..."

# Find PM2 path
PM2_PATH=$(which pm2)
if [ -z "$PM2_PATH" ]; then
    echo "Error: PM2 not found in PATH"
    exit 1
fi
echo "PM2 found at: $PM2_PATH"

cat > /etc/systemd/system/iotistic-agent.service << EOFSVC
[Unit]
Description=Iotistic Agent - IoT Device Management Service
Documentation=https://github.com/Iotistica/iotistic
After=network-online.target docker.service
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/iotistic/agent
Environment=PM2_HOME=/root/.pm2
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Start PM2 process (using no-daemon mode for systemd)
ExecStart=$PM2_PATH start /opt/iotistic/agent/ecosystem.config.js --no-daemon
ExecReload=$PM2_PATH reload /opt/iotistic/agent/ecosystem.config.js
ExecStop=$PM2_PATH kill

# Restart behavior
Restart=always
RestartSec=10

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=iotistic-agent

[Install]
WantedBy=multi-user.target
EOFSVC

# Reload systemd
systemctl daemon-reload

# Enable and start service
echo ""
echo "Starting agent service..."
systemctl enable iotistic-agent
systemctl start iotistic-agent

# Wait for service to start
sleep 10

# Check service status
if systemctl is-active --quiet iotistic-agent; then
    echo ""
    echo "✓ Agent service is running"
    
    # Show PM2 status
    echo ""
    echo "PM2 Status:"
    echo "-----------"
    pm2 list
    
    # Show recent logs
    echo ""
    echo "Recent logs:"
    echo "------------"
    journalctl -u iotistic-agent -n 20 --no-pager
    
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
    echo "  pm2 list                               # List PM2 processes"
    echo "  pm2 logs iotistic-agent                # View PM2 logs"
    echo "  systemctl restart iotistic-agent       # Restart agent"
    echo "  systemctl stop iotistic-agent          # Stop agent"
    echo "  systemctl start iotistic-agent         # Start agent"
    echo ""
else
    echo ""
    echo "✗ Error: Agent service failed to start"
    echo ""
    echo "Service status:"
    systemctl status iotistic-agent --no-pager
    echo ""
    echo "Recent logs:"
    journalctl -u iotistic-agent -n 50 --no-pager
    exit 1
fi

