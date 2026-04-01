#!/bin/bash
set -e

# Iotistica Agent - Unified Installation Script
# Version: AGENT_VERSION_PLACEHOLDER
# This script installs the Iotistic agent using either Docker or Systemd
# Usage: curl -sfL https://get.iotistica.com/agent | sh
#
# Environment Variables (CI/Non-interactive mode):
#   IOTISTICA_AGENT_VERSION        - Agent version to install (default: latest for Docker, dev for Systemd)
#   IOTISTICA_DEVICE_PORT          - Device API port (default: 48484)
#   IOTISTICA_API   - Cloud API endpoint (e.g., https://api.iotistica.com)
#   IOTISTICA_PROVISIONING_KEY     - Provisioning API key (leave empty for local mode)
#   IOTISTICA_INSTALL_DOCKER       - Set to yes/true/1 to allow automatic Docker installation
#   IOTISTICA_INSTALL_MOSQUITTO    - Set to yes/true/1 to install and manage a local Mosquitto broker
#   FORCE_INSTALL                 - Legacy opt-in flag; set to 1 to allow automatic Docker installation

# Note: This script is POSIX-compliant and works with both sh and bash
# No re-exec needed - works when piped to sh

SCRIPT_VERSION="AGENT_VERSION_PLACEHOLDER"

echo "=================================="
echo "Iotistica Agent Installer"
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

# Systemd service name - single source of truth
SERVICE_NAME="iotistica-agent"

# This installer currently relies on apt-get/dpkg for package setup.
# Detect Debian family explicitly so unsupported distros fail fast with a clear error.
is_debian_family() {
    case "$OS" in
        debian|ubuntu|raspbian)
            return 0
            ;;
    esac

    if [ -n "$ID_LIKE" ] && echo "$ID_LIKE" | grep -qi "debian"; then
        return 0
    fi

    return 1
}

# Helper function to install Docker if needed
install_docker_if_needed() {
    REQUIRE_INSTALL="${1:-no}"  # Internal override only; prefer explicit env var opt-in
    
    if command -v docker >/dev/null 2>&1; then
        echo "✓ Docker is already installed ($(docker --version))"
        return 0
    fi
    
    echo "⚠️  Docker is not installed on this system."
    echo ""
    
    # Determine if we should install.
    # Safety default: do NOT auto-install on non-interactive systems unless explicitly opted in.
    SHOULD_INSTALL="no"
    if [ "$REQUIRE_INSTALL" = "yes" ] || [ "$REQUIRE_INSTALL" = "y" ]; then
        SHOULD_INSTALL="yes"
    fi

    if [ "$IOTISTICA_INSTALL_DOCKER" = "yes" ] || [ "$IOTISTICA_INSTALL_DOCKER" = "true" ] || [ "$IOTISTICA_INSTALL_DOCKER" = "1" ]; then
        SHOULD_INSTALL="yes"
    fi

    if [ "$FORCE_INSTALL" = "1" ]; then
        SHOULD_INSTALL="yes"
    fi

    if [ "$SHOULD_INSTALL" != "yes" ] && [ "$SHOULD_INSTALL" != "y" ] && [ -t 0 ]; then
        echo -n "Would you like to install Docker now? (yes/no): "
        read SHOULD_INSTALL
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
        echo "Automatic Docker installation is disabled by default for safety."
        echo ""
        echo "Option 1: Install Docker manually, then rerun this script."
        echo "Option 2: Explicitly allow installer-managed Docker installation by setting:"
        echo "  IOTISTICA_INSTALL_DOCKER=yes"
        echo "  (or FORCE_INSTALL=1)"
        return 1
    fi
}

install_mosquitto_if_needed() {
    if ! command -v setfacl >/dev/null 2>&1; then
        echo "Installing ACL utilities..."
        apt-get install -y --no-install-recommends acl || {
            echo "Error: Failed to install ACL utilities"
            exit 1
        }
    fi

    if command -v mosquitto >/dev/null 2>&1; then
        echo "✓ Mosquitto is already installed ($(mosquitto -h 2>&1 | head -1))"
    else
        echo "Installing Mosquitto..."
        apt-get install -y --no-install-recommends mosquitto mosquitto-clients || {
            echo "Error: Failed to install Mosquitto"
            exit 1
        }
        echo "✓ Mosquitto installed successfully"
    fi

    systemctl enable mosquitto
}

should_manage_mosquitto() {
    SHOULD_INSTALL_MOSQUITTO="no"

    if [ "$IOTISTICA_INSTALL_MOSQUITTO" = "yes" ] || [ "$IOTISTICA_INSTALL_MOSQUITTO" = "true" ] || [ "$IOTISTICA_INSTALL_MOSQUITTO" = "1" ]; then
        SHOULD_INSTALL_MOSQUITTO="yes"
    elif [ "$IOTISTICA_INSTALL_MOSQUITTO" = "no" ] || [ "$IOTISTICA_INSTALL_MOSQUITTO" = "false" ] || [ "$IOTISTICA_INSTALL_MOSQUITTO" = "0" ]; then
        SHOULD_INSTALL_MOSQUITTO="no"
    elif [ -t 0 ]; then
        echo ""
        echo -n "Install and manage a local Mosquitto broker? (yes/no): "
        read SHOULD_INSTALL_MOSQUITTO
    fi

    if [ "$SHOULD_INSTALL_MOSQUITTO" = "yes" ] || [ "$SHOULD_INSTALL_MOSQUITTO" = "y" ]; then
        return 0
    fi

    return 1
}

configure_mosquitto_file_auth() {
    echo ""
    echo "=================================="
    echo "MQTT Broker Setup (Mosquitto)"
    echo "=================================="

    MQTT_AUTH_DIR_VALUE="/etc/mosquitto"
    MQTT_USERNAME_VALUE="${MQTT_USERNAME:-admin}"

    if [ -n "$MQTT_PASSWORD" ]; then
        MQTT_PASSWORD_VALUE="$MQTT_PASSWORD"
    else
        MQTT_PASSWORD_VALUE="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
    fi

    MQTT_BROKER_HOST_VALUE="${MQTT_BROKER_HOST:-localhost}"
    MQTT_BROKER_PORT_VALUE="${MQTT_BROKER_PORT:-1883}"
    MQTT_BROKER_URL_VALUE="mqtt://${MQTT_BROKER_HOST_VALUE}:${MQTT_BROKER_PORT_VALUE}"

    export MQTT_BROKER_HOST_VALUE MQTT_BROKER_PORT_VALUE MQTT_BROKER_URL_VALUE
    export MQTT_AUTH_DIR_VALUE MQTT_USERNAME_VALUE MQTT_PASSWORD_VALUE

    install_mosquitto_if_needed

    echo "Configuring Mosquitto..."
    mkdir -p /etc/mosquitto/conf.d
    mkdir -p /var/log/mosquitto
    chgrp mosquitto /etc/mosquitto
    chmod 2755 /etc/mosquitto

    if ! grep -q '^[[:space:]]*include_dir[[:space:]]\+/etc/mosquitto/conf.d[[:space:]]*$' /etc/mosquitto/mosquitto.conf 2>/dev/null; then
        echo "include_dir /etc/mosquitto/conf.d" >> /etc/mosquitto/mosquitto.conf
    fi

    if [ -f /etc/mosquitto/conf.d/iotistica.conf ]; then
        echo "Updating existing Iotistica Mosquitto config..."
    else
        echo "Creating Iotistica Mosquitto config..."
    fi

    cat > /etc/mosquitto/conf.d/iotistica.conf << EOFMOSQ
# Iotistica managed configuration

listener ${MQTT_BROKER_PORT_VALUE}
allow_anonymous false

password_file /etc/mosquitto/passwd
acl_file /etc/mosquitto/acl
EOFMOSQ

    echo "Initializing MQTT auth files..."
    touch /etc/mosquitto/passwd
    touch /etc/mosquitto/acl
    touch /var/log/mosquitto/mosquitto.log

    mosquitto_passwd -b -c /etc/mosquitto/passwd "$MQTT_USERNAME_VALUE" "$MQTT_PASSWORD_VALUE"

    cat > /etc/mosquitto/acl << EOFACL
# Iotistica managed ACL
user ${MQTT_USERNAME_VALUE}
topic readwrite #
EOFACL

    chown root:root /etc/mosquitto/passwd /etc/mosquitto/acl
    chmod 0700 /etc/mosquitto/passwd
    chmod 0644 /etc/mosquitto/acl
    chown mosquitto:mosquitto /var/log/mosquitto/mosquitto.log
    chmod 640 /var/log/mosquitto/mosquitto.log

    if command -v setfacl >/dev/null 2>&1; then
        setfacl -m u:iotistic:rwx /etc/mosquitto || true
        setfacl -m u:iotistic:rw /etc/mosquitto/passwd || true
        setfacl -m u:iotistic:rw /etc/mosquitto/acl || true
        setfacl -m u:mosquitto:r /etc/mosquitto/passwd || true
        setfacl -m u:mosquitto:r /etc/mosquitto/acl || true
    else
        echo "Warning: setfacl not available; verify the agent user can update /etc/mosquitto/passwd and /etc/mosquitto/acl"
    fi

    cat > /usr/local/bin/iotistica-mqtt-reload.sh << 'EOFRELOAD'
#!/bin/bash
set -e

chown root:root /etc/mosquitto/passwd /etc/mosquitto/acl
chmod 0700 /etc/mosquitto/passwd
chmod 0644 /etc/mosquitto/acl

if command -v setfacl >/dev/null 2>&1; then
    setfacl -m u:iotistic:rw /etc/mosquitto/passwd || true
    setfacl -m u:iotistic:rw /etc/mosquitto/acl || true
    setfacl -m u:mosquitto:r /etc/mosquitto/passwd || true
    setfacl -m u:mosquitto:r /etc/mosquitto/acl || true
fi

systemctl reload mosquitto
EOFRELOAD
    chmod +x /usr/local/bin/iotistica-mqtt-reload.sh

    cat > /etc/sudoers.d/iotistica-mqtt-reload << 'EOFSUDO'
iotistic ALL=(root) NOPASSWD: /usr/local/bin/iotistica-mqtt-reload.sh
EOFSUDO
    chmod 440 /etc/sudoers.d/iotistica-mqtt-reload

    systemctl daemon-reload
    systemctl restart mosquitto

    sleep 3

    if systemctl is-active --quiet mosquitto; then
        echo "✓ Mosquitto is running"
    else
        echo "✗ Mosquitto failed to start"
        systemctl status mosquitto --no-pager
        exit 1
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
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "Error: systemd is not available on this system"
        echo "Please use the Docker installation method instead"
        exit 1
    fi

    # Fail fast on unsupported OS families before running apt-get/dpkg commands.
    if ! is_debian_family; then
        echo "Error: Unsupported OS family for this installer: $OS${OS_VERSION:+ $OS_VERSION}"
        echo ""
        echo "This install path currently supports Debian-family distributions only"
        echo "(debian, ubuntu, raspbian, or ID_LIKE containing 'debian')."
        echo ""
        echo "Detected ID_LIKE: ${ID_LIKE:-<not-set>}"
        echo ""
        echo "Please use a Debian-based OS or add package-manager support for your distro"
        echo "(dnf/yum/apk/opkg) before running this script."
        exit 1
    fi

    # Install system dependencies
    echo "Installing system dependencies..."
    
    # Detect multiarch and warn only.
    # Do not auto-remove foreign architectures or packages because that can
    # remove valid system packages and destabilize the host.
    FOREIGN_ARCHES="$(dpkg --print-foreign-architectures 2>/dev/null || true)"
    if [ -n "$FOREIGN_ARCHES" ]; then
        echo "Warning: multiarch detected: $FOREIGN_ARCHES"
        echo "Warning: installer will not modify foreign architectures automatically."
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
    install_docker_if_needed "no"

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
    if ! id -u iotistic > /dev/null 2>&1; then
        echo ""
        echo "Creating iotistic user..."
        useradd --system --home-dir /opt/iotistic --shell /bin/bash iotistic
        usermod -aG docker iotistic
        echo "✓ User created and added to docker group"
    else
        echo ""
        echo "✓ User iotistic already exists"
        # Ensure user is in docker group even if already exists
        usermod -aG docker iotistic 2>/dev/null || true
    fi

    MQTT_BROKER_URL_VALUE="${MQTT_BROKER_URL:-}"
    MQTT_AUTH_DIR_VALUE=""
    MQTT_USERNAME_VALUE="${MQTT_USERNAME:-}"
    MQTT_PASSWORD_VALUE="${MQTT_PASSWORD:-}"
    MANAGE_LOCAL_MOSQUITTO="no"

    if should_manage_mosquitto; then
        MANAGE_LOCAL_MOSQUITTO="yes"
        configure_mosquitto_file_auth
    else
        echo ""
        echo "Skipping local Mosquitto installation/configuration"
        echo "To enable it explicitly, rerun with IOTISTICA_INSTALL_MOSQUITTO=yes"
    fi

    # Create directories
    echo ""
    echo "Creating directories..."
    mkdir -p /opt/iotistic/agent
    mkdir -p /etc/iotistic
    mkdir -p /var/lib/iotistic/agent
    mkdir -p /var/log/iotistic
    
    # Create OPC UA PKI directory (for certificate storage)
    mkdir -p /opt/iotistic/.config/node-opcua-default-nodejs/PKI
    chown -R iotistic:iotistic /opt/iotistic/.config
    chmod -R 755 /opt/iotistic/.config
    echo "✓ Created OPC UA certificate directory"

    # Configuration
    echo ""
    echo "Configuration:"
    echo "-------------"

    # Detect if we're running from a checked-out repository FIRST
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    AGENT_DIR="$(dirname "$SCRIPT_DIR")"
    
    echo "[DEBUG] Script location:"
    echo "[DEBUG]   script path ($0)=$0"
    echo "[DEBUG]   SCRIPT_DIR=$SCRIPT_DIR"
    echo "[DEBUG]   AGENT_DIR=$AGENT_DIR"
    echo "[DEBUG]   Current directory: $(pwd)"
    echo "[DEBUG]   Files in AGENT_DIR:"
    ls -la "$AGENT_DIR" | head -15
    
    # Function to normalize API endpoint URL
    normalize_api_endpoint() {
        if [ -n "$IOTISTICA_API" ] && ! echo "$IOTISTICA_API" | grep -qE '^https?://'; then
            IOTISTICA_API="http://${IOTISTICA_API}"
            echo "Auto-prepended http:// to API endpoint: $IOTISTICA_API"
        fi
    }
    
    # Check if running interactively
    # Interactive if: NOT in CI mode AND (has terminal OR stdin is from terminal)
    # When piped (curl | sh), stdin is not a tty, but we can still prompt if we redirect from /dev/tty
    if [ -z "$CI" ] && [ -z "$IOTISTICA_AGENT_VERSION" ] && [ -z "$IOTISTICA_DEVICE_PORT" ]; then
        # No CI and no env vars set = assume interactive mode
        echo "Running in interactive mode"
        
        # Prompt for configuration (read directly from /dev/tty to work when piped)
        echo -n "Enter cloud API endpoint (leave empty for local mode): " >/dev/tty
        read IOTISTICA_API < /dev/tty
        echo -n "Enter provisioning API key (leave empty for local mode): " >/dev/tty
        read PROVISIONING_KEY < /dev/tty
        echo -n "Enter device API port [48484]: " >/dev/tty
        read DEVICE_API_PORT < /dev/tty
        DEVICE_API_PORT=${DEVICE_API_PORT:-48484}
        AGENT_VERSION="dev"
    else
        echo "Running in non-interactive mode"
        
        if [ -n "$PROVISIONING_KEY" ]; then
            echo "[DEBUG] PROVISIONING_KEY found in environment (redacted)"
        fi
        DEVICE_API_PORT="${IOTISTICA_DEVICE_PORT:-48484}"
        AGENT_VERSION="${IOTISTICA_AGENT_VERSION:-dev}"
        IOTISTICA_API="${IOTISTICA_API:-}"
    fi
    
    # Normalize API endpoint - add http:// if protocol missing
    normalize_api_endpoint
    
    # If package.json exists in AGENT_DIR, extract version from it
    # This handles the case where install.sh is run from an extracted tarball
    if [ "$AGENT_VERSION" = "dev" ] && [ -f "$AGENT_DIR/package.json" ]; then
        EXTRACTED_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$AGENT_DIR/package.json" | sed 's/.*"\([^"]*\)".*/\1/')
        if [ -n "$EXTRACTED_VERSION" ]; then
            AGENT_VERSION="$EXTRACTED_VERSION"
            echo "Detected version from package.json: $AGENT_VERSION"
        fi
    fi
    
    # Now handle repository access (works for both modes)
    echo "[DEBUG] CI=$CI"
    echo "[DEBUG] SCRIPT_DIR=$SCRIPT_DIR"
    echo "[DEBUG] AGENT_DIR=$AGENT_DIR"
    echo "[DEBUG] Checking for: $AGENT_DIR/package.json"
    echo "[DEBUG] File exists: $([ -f "$AGENT_DIR/package.json" ] && echo 'YES' || echo 'NO')"
    echo "[DEBUG] Checking for: $AGENT_DIR/.git"
    echo "[DEBUG] Directory exists: $([ -d "$AGENT_DIR/.git" ] && echo 'YES' || echo 'NO')"
    
    # In CI mode, ALWAYS use local repository sources (never download)
    # In non-CI mode, use local sources ONLY if it's an actual git repository (has .git directory)
    # This prevents treating an installed agent directory as a repository checkout
    if [ "$CI" = "true" ] || [ -d "$AGENT_DIR/.git" ]; then
        if [ "$CI" = "true" ]; then
            echo "CI mode detected - using repository sources from: $AGENT_DIR"
        else
            echo "Git repository detected - using local checkout from: $AGENT_DIR"
        fi
        
        # Copy agent code
        echo "Copying agent code..."
        cp -r "$AGENT_DIR"/* /opt/iotistic/agent/
        
        echo "✓ Repository code copied to /opt/iotistic/agent"
    else
        # Download pre-built agent from Azure Blob Storage
        echo "Downloading agent from distribution server..."
        
        # Detect architecture for platform-specific tarball
        DETECTED_ARCH=$(uname -m)
        case "$DETECTED_ARCH" in
            aarch64|arm64)
                TARBALL_SUFFIX="-arm64"
                echo "Detected ARM64 architecture - will download ARM-optimized tarball"
                ;;
            x86_64|amd64)
                TARBALL_SUFFIX="-x86_64"
                echo "Detected x86_64 architecture"
                ;;
            *)
                TARBALL_SUFFIX=""
                echo "Unknown architecture ($DETECTED_ARCH) - using generic tarball"
                ;;
        esac
        
        # Determine download URL
        if [ -n "$IOTISTICA_DOWNLOAD_URL" ]; then
            # Custom URL provided
            DOWNLOAD_URL="$IOTISTICA_DOWNLOAD_URL"
        elif [ "$AGENT_VERSION" = "dev" ] || [ "$AGENT_VERSION" = "latest" ]; then
            # Use latest version with architecture suffix
            DOWNLOAD_URL="https://iotistic.blob.core.windows.net/scripts/agent/agent-latest${TARBALL_SUFFIX}.tar.gz"
        else
            # Use specific version with architecture suffix
            DOWNLOAD_URL="https://iotistic.blob.core.windows.net/scripts/agent/versions/agent-${AGENT_VERSION}${TARBALL_SUFFIX}.tar.gz"
        fi
        
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
            echo "  3. Verify the agent version exists: $AGENT_VERSION"
            echo ""
            echo "Available versions: https://iotistic.blob.core.windows.net/scripts/agent/versions/"
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
        
        
        # Clean up ALL existing installation files to ensure fresh install
        echo "Cleaning up existing installation files..."
        rm -rf /opt/iotistic/agent/node_modules
        rm -f /opt/iotistic/agent/package-lock.json
        rm -f /opt/iotistic/agent/package.json
        echo "✓ Cleanup complete"
        
        # Copy extracted files to installation directory
        cp -r iotistic-agent-download/* /opt/iotistic/agent/ || {
            echo "Error: Failed to copy agent files"
            exit 1
        }
        
        
        # Cleanup
        rm -rf iotistic-agent-download agent.tar.gz
        
        echo "✓ Agent downloaded and installed"
        SKIP_BUILD=true
    fi

    # Build agent (only if using repository checkout)
    if [ "$SKIP_BUILD" != "true" ]; then
        echo ""
        echo "Installing agent dependencies..."
        cd /opt/iotistic/agent
        npm ci --legacy-peer-deps

        echo "Building agent..."
        npx tsc --project tsconfig.build.json
        
        echo "Copying database assets..."
        npm run copy:db-assets
        if [ ! -f dist/db/template.sqlite.sql ]; then
            echo "✗ Error: Database asset copy failed - dist/db/template.sqlite.sql not found"
            exit 1
        fi

        if [ ! -f dist/app.js ]; then
            echo "✗ Error: Build failed - dist/app.js not found"
            exit 1
        fi
        echo "✓ Agent built successfully"
    else
        echo ""
        echo "Using pre-built agent from distribution server"
        echo "✓ Skipping build step"
        
        # Verify pre-built files exist
        cd /opt/iotistic/agent
        
        # Debug: Show what's in dist/
        echo "Contents of dist directory:"
        ls -la dist/
        
        if [ ! -d dist ]; then
            echo "✗ Error: Pre-built dist/ directory not found"
            exit 1
        fi
        
        # Check for app.js in multiple possible locations
        if [ -f dist/app.js ]; then
            echo "✓ Found dist/app.js"
        elif [ -f dist/src/app.js ]; then
            echo "✓ Found dist/src/app.js"
        else
            echo "✗ Error: Pre-built app.js not found"
            echo "Searched in:"
            echo "  - dist/app.js"
            echo "  - dist/src/app.js"
            echo ""
            echo "Available files:"
            find dist -name "*.js" | head -20
            exit 1
        fi
        
        echo "✓ Pre-built agent verified (architecture-specific native modules included)"
    fi

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
DATA_DIR=/var/lib/iotistic/agent
STATE_FILE=/var/lib/iotistic/agent/target-state.json
DATABASE_PATH=/var/lib/iotistic/agent/agent.sqlite
EOF

    if [ -n "$MQTT_BROKER_URL_VALUE" ]; then
        echo "MQTT_BROKER_URL=${MQTT_BROKER_URL_VALUE}" >> /etc/iotistic/agent.env
    fi

    if [ -n "$MQTT_AUTH_DIR_VALUE" ]; then
        echo "MQTT_AUTH_DIR=${MQTT_AUTH_DIR_VALUE}" >> /etc/iotistic/agent.env
    fi

    if [ -n "$MQTT_USERNAME_VALUE" ]; then
        echo "MQTT_USERNAME=${MQTT_USERNAME_VALUE}" >> /etc/iotistic/agent.env
    fi

    if [ -n "$MQTT_PASSWORD_VALUE" ]; then
        echo "MQTT_PASSWORD=${MQTT_PASSWORD_VALUE}" >> /etc/iotistic/agent.env
    fi

    # Write CI mode flag if set (for testing environments)
    if [ "$CI" = "true" ]; then
        echo "[DEBUG] Writing CI=true to agent.env (testing mode)"
        echo "CI=true" >> /etc/iotistic/agent.env
        echo "SYSTEMD_READY_MODE=ci" >> /etc/iotistic/agent.env
    fi

    if [ -n "$PROVISIONING_KEY" ]; then
        echo "[DEBUG] Writing PROVISIONING_KEY to agent.env (redacted)"
        echo "PROVISIONING_KEY=${PROVISIONING_KEY}" >> /etc/iotistic/agent.env
    else
        echo "[DEBUG] PROVISIONING_KEY is empty, not writing to agent.env"
    fi

    if [ -n "$IOTISTICA_API" ]; then
        echo "IOTISTICA_API=${IOTISTICA_API}" >> /etc/iotistic/agent.env
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

    NODE_PATH=$(command -v node)
    
    # Auto-detect correct app.js path (handles both old and new build structures)
    if [ -f /opt/iotistic/agent/dist/app.js ]; then
        APP_JS_PATH="/opt/iotistic/agent/dist/app.js"
        echo "Detected app.js at: dist/app.js (new structure)"
    elif [ -f /opt/iotistic/agent/dist/src/app.js ]; then
        APP_JS_PATH="/opt/iotistic/agent/dist/src/app.js"
        echo "Detected app.js at: dist/src/app.js (legacy structure)"
    else
        echo "✗ Error: Could not find app.js in dist/ or dist/src/"
        exit 1
    fi

    echo "Node path: ${NODE_PATH}"
    echo "App path: ${APP_JS_PATH}"

    # Allow install-time override for service memory cap.
    AGENT_MEMORY_LIMIT="${AGENT_MEMORY_LIMIT:-300M}"
    AGENT_MEMORY_HIGH="${AGENT_MEMORY_HIGH:-250M}"
    echo "Service memory limit: ${AGENT_MEMORY_LIMIT}"
    echo "Service memory high watermark: ${AGENT_MEMORY_HIGH}"

    SERVICE_TYPE="notify"
    WATCHDOG_DIRECTIVES=$'# Watchdog configuration (health-gated automatic restart)\nWatchdogSec=60\nNotifyAccess=main'
    STARTUP_TIMEOUT="120"

    if [ "$CI" = "true" ]; then
        echo "CI mode: using systemd Type=simple and disabling watchdog for deterministic startup tests"
        SERVICE_TYPE="simple"
        WATCHDOG_DIRECTIVES="# Watchdog disabled in CI service mode"
        STARTUP_TIMEOUT="60"
    fi

    UNIT_AFTER="network-online.target docker.service"
    UNIT_REQUIRES="docker.service"
    SERVICE_READWRITE_PATHS="/var/lib/iotistic /var/log/iotistic /opt/iotistic/agent /var/run/docker.sock"

    if [ "$MANAGE_LOCAL_MOSQUITTO" = "yes" ]; then
        UNIT_AFTER="$UNIT_AFTER mosquitto.service"
        UNIT_REQUIRES="$UNIT_REQUIRES mosquitto.service"
        SERVICE_READWRITE_PATHS="$SERVICE_READWRITE_PATHS /etc/mosquitto"
    fi
    
    cat > /etc/systemd/system/${SERVICE_NAME}.service << EOFSVC
[Unit]
Description=Iotistic Agent - IoT Device Management Service
Documentation=https://github.com/Iotistica/iotistic
After=${UNIT_AFTER}
Requires=${UNIT_REQUIRES}
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
# Service type differs between production and CI mode
Type=${SERVICE_TYPE}
User=iotistic
Group=iotistic
WorkingDirectory=/opt/iotistic/agent
EnvironmentFile=/etc/iotistic/agent.env
Environment=NODE_ENV=production
Environment=DEPLOYMENT_TYPE=systemd

ExecStart=$NODE_PATH $APP_JS_PATH

# Restart policy (automatic recovery from failures)
Restart=always
RestartSec=5

${WATCHDOG_DIRECTIVES}

# Startup timeout
TimeoutStartSec=${STARTUP_TIMEOUT}

# Graceful shutdown timeout (kill misbehaving services)
TimeoutStopSec=20
KillMode=control-group

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Security hardening (production recommended)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${SERVICE_READWRITE_PATHS}
CapabilityBoundingSet=
LockPersonality=true
MemoryAccounting=true
CPUAccounting=true

# Resource limits (prevent memory leaks from killing device)
LimitNOFILE=65536
LimitNPROC=65536
MemoryHigh=${AGENT_MEMORY_HIGH}
MemoryMax=${AGENT_MEMORY_LIMIT}
TasksMax=512
CPUQuota=80%

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

    # Debug: Show service file contents
    echo ""
    echo "[DEBUG] Systemd service file contents:"
    echo "========================================"
    cat /etc/systemd/system/${SERVICE_NAME}.service
    echo "========================================"
    
    # Debug: Verify dist directory exists
    echo ""
    echo "[DEBUG] Checking dist directory:"
    if [ -d /opt/iotistic/agent/dist ]; then
        echo "✓ dist/ exists"
        ls -la /opt/iotistic/agent/dist/
        if [ -f /opt/iotistic/agent/dist/app.js ]; then
            echo "✓ dist/app.js exists (CORRECT PATH)"
        elif [ -f /opt/iotistic/agent/dist/src/app.js ]; then
            echo "✓ dist/src/app.js exists (LEGACY PATH)"
        else
            echo "✗ app.js NOT FOUND in either location"
            echo "Available .js files:"
            find /opt/iotistic/agent/dist -name "*.js" | head -20
        fi
    else
        echo "✗ dist/ directory NOT FOUND"
    fi
    
    # Start service
    systemctl daemon-reload
    echo ""
    echo "Starting agent service..."
    systemctl enable "${SERVICE_NAME}"
    systemctl start "${SERVICE_NAME}"

    sleep 10

    if systemctl is-active --quiet "${SERVICE_NAME}"; then
        echo ""
        echo "✓ Agent service is running"
        
        echo ""
        echo "Recent logs:"
        journalctl -u "${SERVICE_NAME}" -n 50 --no-pager
        
        echo ""
        echo "====================================="
        echo "Installation complete!"
        echo "====================================="
        echo ""
        echo "Agent is running as systemd service '${SERVICE_NAME}'"
        echo "Device API: http://localhost:${DEVICE_API_PORT}"
        echo ""
        echo "Useful commands:"
        echo "  systemctl status ${SERVICE_NAME}        # Check status"
        echo "  journalctl -u ${SERVICE_NAME} -f        # View logs"
        echo "  systemctl restart ${SERVICE_NAME}       # Restart agent"
        echo "  systemctl stop ${SERVICE_NAME}          # Stop agent"
        echo ""
    else
        echo ""
        echo "✗ Error: Agent service failed to start"
        systemctl status "${SERVICE_NAME}" --no-pager
        journalctl -u "${SERVICE_NAME}" -n 50 --no-pager
        exit 1
    fi
