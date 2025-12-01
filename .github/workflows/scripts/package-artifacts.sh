#!/bin/bash
set -e

BUILD_DIR="$1"
WORKSPACE="$2"
MACHINE="$3"
YOCTO_VERSION="$4"
AGENT_VERSION="$5"

cd "$BUILD_DIR/poky/build"

ARTIFACT_DIR="$WORKSPACE/yocto-artifacts"
mkdir -p "$ARTIFACT_DIR"

# Copy images
cp "tmp/deploy/images/$MACHINE/"*.wic.bz2 "$ARTIFACT_DIR/" 2>/dev/null || true
cp "tmp/deploy/images/$MACHINE/"*.rootfs.ext4 "$ARTIFACT_DIR/" 2>/dev/null || true
cp "tmp/deploy/images/$MACHINE/"*.rootfs.tar.bz2 "$ARTIFACT_DIR/" 2>/dev/null || true

# Create manifest
cat > "$ARTIFACT_DIR/manifest.txt" << EOF
Yocto Build Manifest
====================
Date: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
Yocto Version: $YOCTO_VERSION
Machine: $MACHINE
Agent Version: $AGENT_VERSION

Build Configuration:
- Systemd init system
- Node.js runtime
- PM2 process manager
- Iotistic agent pre-installed

Images:
$(ls -lh "$ARTIFACT_DIR/")
EOF

cat "$ARTIFACT_DIR/manifest.txt"

echo "✓ Artifacts packaged"
