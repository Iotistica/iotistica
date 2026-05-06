#!/bin/bash
set -euo pipefail

BUILD_DIR="$1"
YOCTO_VERSION="$2"
MACHINE="$3"
DL_DIR="$4"
SSTATE_DIR="$5"

if [ -z "${BUILD_DIR}" ] || [ -z "${YOCTO_VERSION}" ] || [ -z "${MACHINE}" ] || [ -z "${DL_DIR}" ] || [ -z "${SSTATE_DIR}" ]; then
  echo "Usage: $0 <build-dir> <yocto-version> <machine> <dl-dir> <sstate-dir>"
  exit 1
fi

cd "$BUILD_DIR/poky"

# Set Python 3.8 for kirkstone
if [ "$YOCTO_VERSION" = "kirkstone" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

# Source build environment
source oe-init-build-env build

# Show current layers
echo "=== Current layers ==="
bitbake-layers show-layers || echo "No layers yet"

# Check if layers exist before adding
echo ""
echo "=== Checking layer directories ==="
ls -la ../../ | grep meta || echo "No meta layers found"

# Add meta-openembedded sublayers (required by meta-virtualization)
echo ""
echo "Adding meta-openembedded sublayers..."
if [ -d "../../meta-openembedded" ]; then
  bitbake-layers add-layer ../../meta-openembedded/meta-oe
  bitbake-layers add-layer ../../meta-openembedded/meta-python
  bitbake-layers add-layer ../../meta-openembedded/meta-networking
  bitbake-layers add-layer ../../meta-openembedded/meta-filesystems
  echo "✓ meta-openembedded sublayers added"
else
  echo "❌ meta-openembedded directory not found"
fi

# Add meta-raspberrypi if needed
if [[ "$MACHINE" == *"raspberrypi"* ]]; then
  echo ""
  echo "Adding meta-raspberrypi layer..."
  if [ -d "../../meta-raspberrypi" ]; then
    bitbake-layers add-layer ../../meta-raspberrypi
    echo "✓ meta-raspberrypi added"
  else
    echo "❌ meta-raspberrypi directory not found"
  fi
fi

# Add meta-virtualization for Docker support
echo ""
echo "Adding meta-virtualization layer (Docker/containers)..."
if [ -d "../../meta-virtualization" ]; then
  bitbake-layers add-layer ../../meta-virtualization
  echo "✓ meta-virtualization added"
else
  echo "❌ meta-virtualization directory not found"
  echo "Docker support will not be available"
fi

# Add meta-iotistic
echo ""
echo "Adding meta-iotistic layer..."
if [ -d "../../meta-iotistic" ]; then
  if [ -f "../../meta-iotistic/conf/layer.conf" ]; then
    bitbake-layers add-layer ../../meta-iotistic
    echo "✓ meta-iotistic added"
  else
    echo "❌ meta-iotistic/conf/layer.conf not found"
  fi
else
  echo "❌ meta-iotistic directory not found"
  exit 1
fi

# Verify layers
echo "=== Layers after adding ==="
bitbake-layers show-layers

# Check distro conf
if [ -f "../../meta-iotistic/conf/distro/iotistic.conf" ]; then
  echo "✓ iotistic.conf found"
else
  echo "❌ iotistic.conf NOT found"
  exit 1
fi

# Configure local.conf if not already configured
if ! grep -q "IotisticOS Configuration" conf/local.conf 2>/dev/null; then
  echo "Adding IotisticOS configuration to local.conf..."
  
  cat >> conf/local.conf << EOF

# IotisticOS Configuration
# ========================

# Use IotisticOS distro
DISTRO = "iotistic"
MACHINE = "${MACHINE}"

# Use shared download directory for build cache
DL_DIR = "${DL_DIR}"
SSTATE_DIR = "${SSTATE_DIR}"

# Parallel build settings (reduced to prevent OOM)
BB_NUMBER_THREADS = "4"
PARALLEL_MAKE = "-j 4"

# Read-only root filesystem
IMAGE_FEATURES:append = " read-only-rootfs"

# Package management for OTA updates
PACKAGE_CLASSES = "package_ipk"
EXTRA_IMAGE_FEATURES:append = " package-management"

# Development features (remove for production)
EXTRA_IMAGE_FEATURES:append = " debug-tweaks"
EXTRA_IMAGE_FEATURES:append = " ssh-server-openssh"

# Reduce image size
INHERIT += "rm_work"

# License compliance
LICENSE_FLAGS_ACCEPTED:append = " commercial"
EOF

  if [[ "$MACHINE" == *"raspberrypi"* ]]; then
    cat >> conf/local.conf << EOF

# Boot partition configuration (Raspberry Pi)
RPI_USE_U_BOOT = "1"
ENABLE_UART = "1"
EOF
  fi
else
  echo "IotisticOS configuration already in local.conf"
fi

# Show settings
echo "=== local.conf DISTRO and MACHINE settings ==="
grep -E "^DISTRO|^MACHINE|^PACKAGE_CLASSES" conf/local.conf

# Verify distro config
echo ""
echo "=== Verifying distro configuration ==="
if [ -f "../../meta-iotistic/conf/distro/iotistic.conf" ]; then
  echo "✓ iotistic.conf exists"
  echo "PACKAGE_CLASSES setting in distro conf:"
  grep "PACKAGE_CLASSES" ../../meta-iotistic/conf/distro/iotistic.conf
else
  echo "❌ ERROR: iotistic.conf NOT FOUND!"
  exit 1
fi

# Force IPK with highest priority
echo ""
echo "=== Enforcing IPK package manager with HIGHEST priority ==="
sed -i '/^PACKAGE_CLASSES/d' conf/local.conf
echo "" >> conf/local.conf
echo "# FORCE IPK package manager with :forcevariable (highest priority)" >> conf/local.conf
echo "PACKAGE_CLASSES:forcevariable = \"package_ipk\"" >> conf/local.conf

if [[ "$MACHINE" == *"raspberrypi"* ]]; then
  if ! grep -q '^RPI_USE_U_BOOT' conf/local.conf; then
    echo 'RPI_USE_U_BOOT = "1"' >> conf/local.conf
  fi
  if ! grep -q '^ENABLE_UART' conf/local.conf; then
    echo 'ENABLE_UART = "1"' >> conf/local.conf
  fi
fi

echo "✓ IPK forced with :forcevariable in local.conf"

# Show final setting
echo "Final PACKAGE_CLASSES:"
grep "PACKAGE_CLASSES" conf/local.conf | tail -1

echo "✓ Build configuration complete"
