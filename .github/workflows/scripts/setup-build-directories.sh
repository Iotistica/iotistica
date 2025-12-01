#!/bin/bash
set -e

BUILD_DIR="$1"
DL_DIR="$2"
SSTATE_DIR="$3"

echo "Setting up Yocto build directories..."

# Create persistent directories (idempotent - safe to run multiple times)
sudo mkdir -p "$BUILD_DIR"
sudo mkdir -p "$DL_DIR"
sudo mkdir -p "$SSTATE_DIR"

# Set ownership to current user (works for both 'runner' and other usernames)
sudo chown -R $(whoami):$(whoami) "$BUILD_DIR"
sudo chown -R $(whoami):$(whoami) "$DL_DIR"
sudo chown -R $(whoami):$(whoami) "$SSTATE_DIR"

# Verify directories and show disk space
echo ""
echo "=== Yocto Build Directories ==="
ls -ld /opt/yocto-* 2>/dev/null || echo "Directories created: $BUILD_DIR, $DL_DIR, $SSTATE_DIR"

echo ""
echo "=== Disk Space on /opt ==="
df -h /opt

echo ""
echo "✓ Build directories ready"
