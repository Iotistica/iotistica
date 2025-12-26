#!/bin/bash
# vim: tabstop=4 shiftwidth=4 softtabstop=4
# -*- sh-basic-offset: 4 -*-

set -euo pipefail

echo "🔄 Iotistic Agent Update (Docker Mode)"
echo "======================================"

# Parse arguments
TARGET_VERSION="${1:-latest}"
FORCE="${2:-false}"
LOCK_FILE="${3:-/var/lib/iotistic/agent/update.lock}"

# Cleanup function to remove lock file on exit
cleanup_lock() {
    if [ -f "$LOCK_FILE" ]; then
        rm -f "$LOCK_FILE"
        echo "🔓 Update lock removed"
    fi
}

# Register cleanup on script exit (success or failure)
trap cleanup_lock EXIT INT TERM

# Get current version
CURRENT_VERSION=$(docker inspect iotistic-agent --format='{{.Config.Image}}' 2>/dev/null | cut -d':' -f2 || echo "unknown")
echo "Current version: $CURRENT_VERSION"

# Resolve latest if needed
if [ "$TARGET_VERSION" = "latest" ]; then
    echo "Fetching latest version from Docker Hub..."
    LATEST_VERSION=$(curl -s https://registry.hub.docker.com/v2/repositories/iotistic/agent/tags \
        | jq -r '.results[].name' \
        | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
        | sort -V \
        | tail -1)
    
    if [ -z "$LATEST_VERSION" ]; then
        echo "❌ Failed to fetch latest version from Docker Hub"
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
BACKUP_DIR="/tmp/iotistic-agent-backups"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Pull new image
echo ""
echo "📥 Pulling new image..."
if ! docker pull "iotistic/agent:$TARGET_VERSION"; then
    echo "❌ Failed to pull image iotistic/agent:$TARGET_VERSION"
    exit 1
fi

# Backup current container config
echo ""
echo "💾 Backing up container configuration..."
docker inspect iotistic-agent > "$BACKUP_DIR/agent-config-$TIMESTAMP.json"

# Extract current configuration
echo "Extracting current configuration..."
ENV_VARS=$(docker inspect iotistic-agent --format='{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -v '^PATH=' \
    | grep -v '^HOSTNAME=' \
    | sed 's/^/-e /' \
    | tr '\n' ' ')

VOLUMES=$(docker inspect iotistic-agent --format='{{range .Mounts}}{{if eq .Type "volume"}}-v {{.Name}}:{{.Destination}} {{end}}{{end}}')

BIND_MOUNTS=$(docker inspect iotistic-agent --format='{{range .Mounts}}{{if eq .Type "bind"}}-v {{.Source}}:{{.Destination}} {{end}}{{end}}')

# Stop current container
echo ""
echo "⏸️  Stopping current container..."
if ! docker stop iotistic-agent; then
    echo "❌ Failed to stop container"
    exit 1
fi

# Rename old container for rollback capability
echo "Renaming old container for rollback..."
docker rename iotistic-agent "iotistic-agent-backup-$TIMESTAMP"

# Start new container with same configuration
echo ""
echo "🚀 Starting new container..."
if ! docker run -d \
    --name iotistic-agent \
    --restart unless-stopped \
    --network host \
    --privileged \
    -v /var/run/docker.sock:/var/run/docker.sock \
    $VOLUMES \
    $BIND_MOUNTS \
    $ENV_VARS \
    -e AGENT_VERSION="$TARGET_VERSION" \
    "iotistic/agent:$TARGET_VERSION"; then
    
    echo "❌ Failed to start new container, rolling back..."
    
    # Remove failed container
    docker rm iotistic-agent 2>/dev/null || true
    
    # Restore old container
    docker rename "iotistic-agent-backup-$TIMESTAMP" iotistic-agent
    docker start iotistic-agent
    
    echo "⚠️  Rollback complete, agent restored to version $CURRENT_VERSION"
    exit 1
fi

# Wait for container to stabilize
echo ""
echo "⏳ Waiting for agent to start..."
sleep 5

# Verify new container is running
if docker ps | grep -q "iotistic-agent"; then
    NEW_VERSION=$(docker inspect iotistic-agent --format='{{.Config.Image}}' | cut -d':' -f2)
    
    echo ""
    echo "✅ Agent updated successfully!"
    echo "   Old version: $CURRENT_VERSION"
    echo "   New version: $NEW_VERSION"
    echo ""
    echo "📋 Recent logs:"
    docker logs --tail 20 iotistic-agent
    
    # Cleanup old container after successful update
    echo ""
    echo "🧹 Cleaning up old container..."
    docker rm "iotistic-agent-backup-$TIMESTAMP" 2>/dev/null || true
    
    # Keep only last 3 backups
    ls -t "$BACKUP_DIR"/agent-config-*.json 2>/dev/null | tail -n +4 | xargs rm -f 2>/dev/null || true
    
    echo ""
    echo "✅ Update complete!"
    
else
    echo "❌ New container failed to start, rolling back..."
    
    # Stop and remove failed container
    docker stop iotistic-agent 2>/dev/null || true
    docker rm iotistic-agent 2>/dev/null || true
    
    # Restore old container
    docker rename "iotistic-agent-backup-$TIMESTAMP" iotistic-agent
    docker start iotistic-agent
    
    echo "⚠️  Rollback complete, agent restored to version $CURRENT_VERSION"
    exit 1
fi
