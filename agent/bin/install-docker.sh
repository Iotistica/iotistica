#!/bin/bash
set -e

# Iotistic Agent - Docker Installation Script
# Version: AGENT_VERSION_PLACEHOLDER
# This script installs the Iotistic agent as a Docker container
# Usage: curl -sSL https://apps.iotistic.ca/agent/install-docker.sh | bash
#
# Environment Variables (CI/Non-interactive mode):
#   IOTISTIC_AGENT_VERSION        - Agent version to install (default: latest)
#   IOTISTIC_DEVICE_PORT          - Device API port (default: 48484)
#   IOTISTIC_IOTISTICA_API   - Cloud API endpoint (e.g., https://api.iotistic.ca)
#   IOTISTIC_PROVISIONING_KEY     - Provisioning API key (leave empty for local mode)

SCRIPT_VERSION="AGENT_VERSION_PLACEHOLDER"

echo "=================================="
echo "Iotistic Agent - Docker Installer"
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

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo ""
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
        echo "Error: Docker is required to run the Iotistic agent."
        echo "Please install Docker manually and run this script again."
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
echo "Creating directories..."
mkdir -p /var/lib/iotistic/agent
mkdir -p /var/log/iotistic

# Prompt for configuration
echo ""
echo "Configuration:"
echo "-------------"

# Check if running in non-interactive mode (CI)
# Only use non-interactive if CI is explicitly set OR if being piped (e.g., curl | bash)
if [ -n "$CI" ]; then
    echo "Running in CI mode (non-interactive)"
    PROVISIONING_KEY="${IOTISTIC_PROVISIONING_KEY:-}"
    DEVICE_API_PORT="${IOTISTIC_DEVICE_PORT:-48484}"
    AGENT_VERSION="${IOTISTIC_AGENT_VERSION:-latest}"
    IOTISTICA_API="${IOTISTIC_IOTISTICA_API:-}"
elif [ ! -t 0 ] && [ -z "$FORCE_INTERACTIVE" ]; then
    echo "Running in non-interactive mode (stdin is not a terminal)"
    echo "Set FORCE_INTERACTIVE=1 to enable prompts, or set these environment variables:"
    echo "  - IOTISTIC_IOTISTICA_API"
    echo "  - IOTISTIC_PROVISIONING_KEY"
    echo "  - IOTISTIC_DEVICE_PORT (default: 48484)"
    echo "  - IOTISTIC_AGENT_VERSION (default: latest)"
    echo ""
    PROVISIONING_KEY="${IOTISTIC_PROVISIONING_KEY:-}"
    DEVICE_API_PORT="${IOTISTIC_DEVICE_PORT:-48484}"
    AGENT_VERSION="${IOTISTIC_AGENT_VERSION:-latest}"
    IOTISTICA_API="${IOTISTIC_IOTISTICA_API:-}"
else
    # Interactive mode - prompt user
    # Cloud API endpoint
    read -p "Enter cloud API endpoint (leave empty for local mode): " IOTISTICA_API
    
    # Provisioning key (optional)
    read -p "Enter provisioning API key (leave empty for local mode): " PROVISIONING_KEY

    # Agent port
    read -p "Enter device API port [48484]: " DEVICE_API_PORT
    DEVICE_API_PORT=${DEVICE_API_PORT:-48484}
    
    # Get latest version
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

# Build environment variables for docker run
ENV_VARS="-e DEVICE_API_PORT=48484 \
    -e AGENT_VERSION=${AGENT_VERSION} \
    -e NODE_ENV=production \
    -e LOG_LEVEL=info \
    -e ORCHESTRATOR_TYPE=docker-compose \
    -e ORCHESTRATOR_INTERVAL=30000"

# Add PROVISIONING_API_KEY if provided
if [ -n "$PROVISIONING_KEY" ]; then
    ENV_VARS="$ENV_VARS -e PROVISIONING_API_KEY=${PROVISIONING_KEY}"
fi

# Add IOTISTICA_API if provided
if [ -n "$IOTISTICA_API" ]; then
    ENV_VARS="$ENV_VARS -e IOTISTICA_API=${IOTISTICA_API}"
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
    
    # Show logs
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

