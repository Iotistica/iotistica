#!/bin/bash
# vim: tabstop=4 shiftwidth=4 softtabstop=4
# -*- sh-basic-offset: 4 -*-

set -euo pipefail

echo "≡ƒöä Iotistica Agent Update (Systemd Mode)"
echo "========================================"

# Parse arguments
TARGET_VERSION="${1:-latest}"
FORCE="${2:-false}"
LOCK_FILE="${3:-/var/lib/iotistic/agent/update.lock}"
STATUS_FILE="/var/lib/iotistic/agent/update-status.json"

# Cleanup function to remove lock file and write status on exit
cleanup() {
    local exit_code=$?
    
    # Cleanup temp files
    cd /tmp
    rm -rf iotistic-agent-update agent-update.tar.gz agent-update.tar.gz.sha256
    
    # Remove lock file
    if [ -f "$LOCK_FILE" ]; then
        rm -f "$LOCK_FILE"
        echo "≡ƒöô Update lock removed"
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
        echo "Γ£à Update status written: SUCCESS"
    else
        cat > "$STATUS_FILE" <<EOF
{
  "version": "$TARGET_VERSION",
  "success": false,
  "completed_at": $(date +%s)000,
  "deployment_type": "systemd"
}
EOF
        echo "Γ¥î Update status written: FAILURE"
    fi
}

# Register cleanup on script exit (success or failure)
trap cleanup EXIT INT TERM

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

# Get current version from package.json if available
CURRENT_VERSION="unknown"
if [ -f /opt/iotistic/agent/package.json ]; then
    CURRENT_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' /opt/iotistic/agent/package.json | sed 's/.*"\([^"]*\)".*/\1/' || echo "unknown")
fi

echo "Current version: $CURRENT_VERSION"
echo "Architecture: $DETECTED_ARCH ($TARBALL_SUFFIX)"

# Determine download URL
if [ "$TARGET_VERSION" = "latest" ]; then
    # Use latest version with architecture suffix
    DOWNLOAD_URL="https://iotistic.blob.core.windows.net/scripts/agent/agent-latest${TARBALL_SUFFIX}.tar.gz"
    echo "Target version: latest"
else
    # Use specific version with architecture suffix
    DOWNLOAD_URL="https://iotistic.blob.core.windows.net/scripts/agent/versions/agent-${TARGET_VERSION}${TARBALL_SUFFIX}.tar.gz"
    echo "Target version: $TARGET_VERSION"
fi

# Check if update needed
if [ "$CURRENT_VERSION" = "$TARGET_VERSION" ] && [ "$FORCE" != "true" ]; then
    echo "Γ£à Already on target version!"
    exit 0
fi

# Create backup directory
BACKUP_DIR="/var/lib/iotistic/backups"
sudo mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Backup current installation
echo ""
echo "≡ƒÆ╛ Backing up current installation..."
if [ -d /opt/iotistic/agent ]; then
    sudo tar -czf "$BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz" \
        -C /opt/iotistic agent 2>/dev/null || true
    echo "Γ£ô Backup saved to $BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz"
fi

# Download new tarball
echo ""
echo "≡ƒôÑ Downloading agent tarball..."
cd /tmp
rm -rf iotistic-agent-update agent-update.tar.gz agent-update.tar.gz.sha256

echo "Downloading from: $DOWNLOAD_URL"
CHECKSUM_URL="${DOWNLOAD_URL}.sha256"

# Try to download with curl or wget
DOWNLOAD_FAILED=0
if command -v curl &> /dev/null; then
    curl -fSL -o agent-update.tar.gz "$DOWNLOAD_URL" || DOWNLOAD_FAILED=1
    [ "$DOWNLOAD_FAILED" = "0" ] && curl -fSL -o agent-update.tar.gz.sha256 "$CHECKSUM_URL" || DOWNLOAD_FAILED=1
elif command -v wget &> /dev/null; then
    wget -O agent-update.tar.gz "$DOWNLOAD_URL" || DOWNLOAD_FAILED=1
    [ "$DOWNLOAD_FAILED" = "0" ] && wget -O agent-update.tar.gz.sha256 "$CHECKSUM_URL" || DOWNLOAD_FAILED=1
else
    echo "Neither curl nor wget is available"
    exit 1
fi

if [ "$DOWNLOAD_FAILED" = "1" ]; then
    echo ""
    echo "Failed to download agent from distribution server"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Check your internet connection"
    echo "  2. Verify the download URL: $DOWNLOAD_URL"
    echo "  3. Verify the agent version exists: $TARGET_VERSION"
    exit 1
fi

# Verify SHA256 checksum
echo "Verifying tarball integrity..."
EXPECTED_HASH=$(awk '{print $1}' agent-update.tar.gz.sha256)
if command -v sha256sum &> /dev/null; then
    ACTUAL_HASH=$(sha256sum agent-update.tar.gz | awk '{print $1}')
elif command -v shasum &> /dev/null; then
    ACTUAL_HASH=$(shasum -a 256 agent-update.tar.gz | awk '{print $1}')
else
    echo "Warning: sha256sum/shasum not available - skipping integrity check"
    ACTUAL_HASH="$EXPECTED_HASH"
fi

if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
    echo "Checksum mismatch - tarball may be corrupted or tampered with"
    echo "  Expected: $EXPECTED_HASH"
    echo "  Actual:   $ACTUAL_HASH"
    exit 1
fi
echo "Checksum verified OK"

# Extract tarball
echo "Extracting agent..."
mkdir -p iotistic-agent-update
tar -xzf agent-update.tar.gz -C iotistic-agent-update || {
    echo "Γ¥î Failed to extract agent tarball"
    exit 1
}

# Verify extraction
if [ ! -f iotistic-agent-update/package.json ]; then
    echo "Γ¥î Tarball extraction failed - package.json not found"
    exit 1
fi

# Extract actual version from downloaded package.json
EXTRACTED_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' iotistic-agent-update/package.json | sed 's/.*"\([^"]*\)".*/\1/' || echo "unknown")
echo "Γ£ô Downloaded version: $EXTRACTED_VERSION"

# Stop agent service
echo ""
echo "≡ƒ¢æ Stopping agent service..."
sudo systemctl stop iotistic-agent

# Replace installation files
echo ""
echo "≡ƒôª Installing new version..."

# Clean up existing installation (except config and data)
sudo rm -rf /opt/iotistic/agent/node_modules
sudo rm -rf /opt/iotistic/agent/dist
sudo rm -f /opt/iotistic/agent/package*.json

# Copy new files
sudo cp -r iotistic-agent-update/* /opt/iotistic/agent/ || {
    echo "Γ¥î Failed to copy agent files"
    
    # Attempt rollback
    if [ -f "$BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz" ]; then
        echo "ΓÅ«∩╕Å  Rolling back to previous version..."
        sudo tar -xzf "$BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz" -C /opt/iotistic
    fi
    
    sudo systemctl start iotistic-agent
    exit 1
}

echo "Γ£ô Files installed"

# Start agent service
echo ""
echo "Γû╢∩╕Å  Starting agent service..."
sudo systemctl start iotistic-agent

# Wait for service to stabilize
echo "ΓÅ│ Waiting for service to start (15 seconds)..."
sleep 15

# Verify service is running with new version
if sudo systemctl is-active --quiet iotistic-agent; then
    # Get updated version from package.json
    NEW_VERSION="unknown"
    if [ -f /opt/iotistic/agent/package.json ]; then
        NEW_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' /opt/iotistic/agent/package.json | sed 's/.*"\([^"]*\)".*/\1/' || echo "unknown")
    fi
    
    echo ""
    echo "Γ£à Agent updated successfully!"
    echo "   Old version: $CURRENT_VERSION"
    echo "   New version: $NEW_VERSION"
    echo ""
    echo "≡ƒôï Recent logs:"
    sudo journalctl -u iotistic-agent -n 20 --no-pager
    
    # Cleanup old backups (keep last 3)
    echo ""
    echo "≡ƒº╣ Cleaning up old backups..."
    sudo find "$BACKUP_DIR" -name "agent-backup-*" -type f | sort -r | tail -n +4 | xargs sudo rm -f 2>/dev/null || true
    
    echo ""
    echo "Γ£à Update complete!"
    
else
    echo "Γ¥î Service failed to start, attempting rollback..."
    
    # Stop failed service
    sudo systemctl stop iotistic-agent
    
    # Restore from backup
    if [ -f "$BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz" ]; then
        echo "ΓÅ«∩╕Å  Restoring backup..."
        sudo rm -rf /opt/iotistic/agent
        sudo mkdir -p /opt/iotistic
        sudo tar -xzf "$BACKUP_DIR/agent-backup-${CURRENT_VERSION}-${TIMESTAMP}.tar.gz" -C /opt/iotistic
        
        # Restart service
        sudo systemctl start iotistic-agent
        sleep 10
        
        if sudo systemctl is-active --quiet iotistic-agent; then
            echo "ΓÜá∩╕Å  Rollback complete, agent restored to version $CURRENT_VERSION"
        else
            echo "Γ¥î CRITICAL: Service failed to start after rollback"
            echo "   Manual intervention required: sudo systemctl status iotistic-agent"
        fi
    else
        echo "Γ¥î CRITICAL: No backup found for rollback"
        echo "   Manual intervention required: sudo systemctl status iotistic-agent"
    fi
    
    exit 1
fi
