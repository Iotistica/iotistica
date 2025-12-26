#!/bin/bash
# vim: tabstop=4 shiftwidth=4 softtabstop=4
# -*- sh-basic-offset: 4 -*-

set -euo pipefail

echo "🔄 Iotistic Agent Update (Systemd Mode)"
echo "========================================"

# Parse arguments
TARGET_VERSION="${1:-latest}"
FORCE="${2:-false}"
LOCK_FILE="${3:-/var/lib/iotistic/agent/update.lock}"
STATUS_FILE="/var/lib/iotistic/agent/update-status.json"

# Cleanup function to remove lock file and write status on exit
cleanup() {
    local exit_code=$?
    
    # Remove lock file
    if [ -f "$LOCK_FILE" ]; then
        rm -f "$LOCK_FILE"
        echo "🔓 Update lock removed"
    fi
    
    # Write status file (agent reads this on next boot)
    if [ $exit_code -eq 0 ]; then
        cat > "$STATUS_FILE" <<EOF
{
  "version": "$TARGET_VERSION",
  "success": true,
  "completed_at": $(date +%s)000,
  "deployment_type": "systemd"
}
EOF
        echo "✅ Update status written: SUCCESS"
    else
        cat > "$STATUS_FILE" <<EOF
{
  "version": "$TARGET_VERSION",
  "success": false,
  "completed_at": $(date +%s)000,
  "deployment_type": "systemd"
}
EOF
        echo "❌ Update status written: FAILURE"
    fi
}

# Register cleanup on script exit (success or failure)
trap cleanup EXIT INT TERM

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
    x86_64) ARCH_NAME="amd64" ;;
    aarch64) ARCH_NAME="arm64" ;;
    armv7l) ARCH_NAME="armv7" ;;
    *)
        echo "❌ Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Get current version
CURRENT_VERSION=$(iotistic-agent --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
echo "Current version: $CURRENT_VERSION"
echo "Architecture: $ARCH ($ARCH_NAME)"

# Resolve latest if needed
if [ "$TARGET_VERSION" = "latest" ]; then
    echo "Fetching latest version from GitHub..."
    LATEST_VERSION=$(curl -s https://api.github.com/repos/Iotistica/iotistic/releases/latest \
        | jq -r '.tag_name' | sed 's/^v//')
    
    if [ -z "$LATEST_VERSION" ] || [ "$LATEST_VERSION" = "null" ]; then
        echo "❌ Failed to fetch latest version from GitHub"
        exit 1
    fi
    
    TARGET_VERSION="$LATEST_VERSION"
fi

echo "Target version: $TARGET_VERSION"

# Check if update needed
if [ "$CURRENT_VERSION" = "$TARGET_VERSION" ] && [ "$FORCE" != "true" ]; then
    echo "✅ Already on target version!"
    exit 0
fi

# Create backup directory
BACKUP_DIR="/var/lib/iotistic/backups"
sudo mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Download new binary
echo ""
echo "📥 Downloading agent binary..."
DOWNLOAD_URL="https://github.com/Iotistica/iotistic/releases/download/v${TARGET_VERSION}/iotistic-agent-linux-${ARCH_NAME}"

if ! curl -L "$DOWNLOAD_URL" -o "/tmp/iotistic-agent-${TARGET_VERSION}"; then
    echo "❌ Failed to download binary from $DOWNLOAD_URL"
    exit 1
fi

# Verify download
if [ ! -s "/tmp/iotistic-agent-${TARGET_VERSION}" ]; then
    echo "❌ Downloaded file is empty"
    exit 1
fi

chmod +x "/tmp/iotistic-agent-${TARGET_VERSION}"

# Test new binary
echo ""
echo "🧪 Testing new binary..."
if ! "/tmp/iotistic-agent-${TARGET_VERSION}" --version &>/dev/null; then
    echo "❌ New binary failed version check"
    rm -f "/tmp/iotistic-agent-${TARGET_VERSION}"
    exit 1
fi

# Backup old binary (before replacement)
echo ""
echo "💾 Backing up current binary..."
if [ -f /usr/local/bin/iotistic-agent ]; then
    sudo cp /usr/local/bin/iotistic-agent "$BACKUP_DIR/iotistic-agent-${CURRENT_VERSION}-${TIMESTAMP}"
fi

# Install new binary (agent still running at this point)
echo ""
echo "📦 Installing new binary..."
sudo mv "/tmp/iotistic-agent-${TARGET_VERSION}" /usr/local/bin/iotistic-agent
sudo chmod +x /usr/local/bin/iotistic-agent
sudo chown root:root /usr/local/bin/iotistic-agent

# At this point:
# - Agent process has already exited cleanly (called process.exit(0))
# - systemd's Restart=always policy will restart the service automatically
# - New binary is in place, restart will use updated version
# - No manual systemctl stop/start needed - let systemd handle it

echo ""
echo "✅ Binary replaced successfully"
echo "   systemd will restart agent automatically (Restart=always)"
echo ""
echo "⏳ Waiting for systemd restart (30 seconds)..."
sleep 30

# Verify service is running with new version
if sudo systemctl is-active --quiet iotistic-agent; then
    NEW_VERSION=$(iotistic-agent --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "unknown")
    
    echo ""
    echo "✅ Agent updated successfully!"
    echo "   Old version: $CURRENT_VERSION"
    echo "   New version: $NEW_VERSION"
    echo ""
    echo "📋 Recent logs:"
    sudo journalctl -u iotistic-agent -n 20 --no-pager
    
    # Cleanup old backups (keep last 3)
    echo ""
    echo "🧹 Cleaning up old backups..."
    sudo find "$BACKUP_DIR" -name "iotistic-agent-*" -type f | sort -r | tail -n +4 | xargs sudo rm -f 2>/dev/null || true
    
    echo ""
    echo "✅ Update complete!"
    
else
    echo "❌ Service failed to start, rolling back..."
    
    # Restore old binary
    if [ -f "$BACKUP_DIR/iotistic-agent-${CURRENT_VERSION}-${TIMESTAMP}" ]; then
        sudo cp "$BACKUP_DIR/iotistic-agent-${CURRENT_VERSION}-${TIMESTAMP}" /usr/local/bin/iotistic-agent
        sudo chmod +x /usr/local/bin/iotistic-agent
    fi
    
    # systemd will restart service automatically with old binary
    echo "⏳ Waiting for systemd to restart with old binary..."
    sleep 10
    
    if sudo systemctl is-active --quiet iotistic-agent; then
        echo "⚠️  Rollback complete, agent restored to version $CURRENT_VERSION"
    else
        echo "❌ CRITICAL: Service failed to start after rollback"
        echo "   Manual intervention required: sudo systemctl status iotistic-agent"
    fi
    
    exit 1
fi
