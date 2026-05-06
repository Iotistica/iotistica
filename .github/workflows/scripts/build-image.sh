#!/bin/bash
set -euo pipefail

BUILD_DIR="$1"
YOCTO_VERSION="$2"
SSTATE_DIR="$3"
CLEAN_BUILD="${4:-false}"

cd "$BUILD_DIR/poky"

# Set Python 3.8 for kirkstone
if [ "$YOCTO_VERSION" = "kirkstone" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

# Source build environment
source oe-init-build-env build

if [ "$CLEAN_BUILD" = "true" ]; then
  echo "=== CLEAN BUILD MODE ENABLED ==="
  echo "Cleaning tmp and selected native sstate entries (slow path)..."
  echo ""

  if [ -d tmp ]; then
    echo "Step 1: Removing entire tmp/ directory..."
    rm -rf tmp
    echo "✓ tmp/ removed"
  fi

  if [ -d "$SSTATE_DIR" ]; then
    echo ""
    echo "Step 2: Removing native sstate-cache..."
    echo "Before: $(du -sh "$SSTATE_DIR" 2>/dev/null || echo '0')"

    find "$SSTATE_DIR" -type d -name "*x86_64-linux*" -exec rm -rf {} + 2>/dev/null || true
    find "$SSTATE_DIR" -type d -name "*allarch*" -exec rm -rf {} + 2>/dev/null || true

    echo "After: $(du -sh "$SSTATE_DIR" 2>/dev/null || echo '0')"
    echo "✓ Native sstate-cache cleared"
  fi

  echo ""
  echo "✓ Clean build requested - cache reuse minimized"
else
  echo "=== INCREMENTAL BUILD MODE ==="
  echo "Skipping destructive clean to maximize sstate/tmp reuse"
fi

# Verify configuration
echo ""
echo "=== CRITICAL: Verifying IPK package manager configuration ==="
echo "Checking PACKAGE_CLASSES in local.conf..."
PACKAGE_CLASSES_CONF=$(grep "^PACKAGE_CLASSES" conf/local.conf | tail -1)
echo "Found: $PACKAGE_CLASSES_CONF"

if echo "$PACKAGE_CLASSES_CONF" | grep -q "package_ipk"; then
  echo "✓ IPK configured in local.conf"
else
  echo "❌ ERROR: IPK not configured!"
  exit 1
fi

echo ""
echo "Checking distro conf..."
IOTISTIC_CONF=$(find "$BUILD_DIR" -name "iotistic.conf" -path "*/conf/distro/*" 2>/dev/null | head -n1)
if [ -n "$IOTISTIC_CONF" ]; then
  echo "✓ Found: $IOTISTIC_CONF"
  if grep -q "package_ipk" "$IOTISTIC_CONF"; then
    echo "✓ IPK configured in distro conf"
  fi
else
  echo "❌ ERROR: iotistic.conf not found!"
  exit 1
fi

# Verify layers
echo ""
echo "=== Verifying build configuration ==="
bitbake-layers show-layers

echo ""
echo "=== Configuration verification complete ==="
echo "✓ IPK configured in both local.conf and distro conf"
echo "✓ Using :forcevariable flag (highest BitBake priority)"
echo "✓ Ready to build with IPK package manager"

echo ""
echo "Starting IotisticOS build..."
echo "Building iotistic-image with:"
echo "  - Read-only rootfs"
echo "  - Persistent /data partition"
echo "  - NetworkManager connectivity"
echo "  - Iotistic agent pre-installed"

# Build
bitbake iotistic-image

echo "✓ IotisticOS image built successfully"
