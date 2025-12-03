#!/bin/bash
set -euo pipefail

BUILD_DIR="$1"
YOCTO_VERSION="$2"
MACHINE="$3"
DL_DIR="$4"
SSTATE_DIR="$5"

if [ -z "$BUILD_DIR" ] || [ -z "$YOCTO_VERSION" ] || [ -z "$MACHINE" ]; then
    echo "Usage: $0 <build_dir> <yocto_version> <machine> <dl_dir> <sstate_dir>"
    exit 1
fi

cd "$BUILD_DIR/poky"

# Python workaround for kirkstone
if [ "$YOCTO_VERSION" = "kirkstone" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

# Initialize environment
source oe-init-build-env build

echo "=== Current layers ==="
bitbake-layers show-layers || true

echo ""
echo "=== Checking layer directories ==="
ls -l ../../ | grep meta || echo "No meta layers found"

add_layer_if_exists() {
    local path="$1"
    if [ -d "$path" ]; then
        echo "Adding layer: $path"
        bitbake-layers add-layer "$path" || true
    else
        echo "WARNING: Layer not found: $path"
    fi
}

echo ""
echo "=== Adding meta-openembedded ==="
add_layer_if_exists "../../meta-openembedded/meta-oe"
add_layer_if_exists "../../meta-openembedded/meta-python"
add_layer_if_exists "../../meta-openembedded/meta-networking"
add_layer_if_exists "../../meta-openembedded/meta-filesystems"

if [[ "$MACHINE" == *"raspberrypi"* ]]; then
  echo ""
  echo "=== Adding meta-raspberrypi ==="
  add_layer_if_exists "../../meta-raspberrypi"
fi

echo ""
echo "=== Adding meta-virtualization ==="
add_layer_if_exists "../../meta-virtualization"

echo ""
echo "=== Adding meta-iotistic ==="
if [ ! -d "../../meta-iotistic" ]; then
    echo "ERROR: meta-iotistic not found"
    exit 1
fi
add_layer_if_exists "../../meta-iotistic"

echo ""
echo "=== Layers after adding ==="
bitbake-layers show-layers

if [ ! -f "../../meta-iotistic/conf/distro/iotistic.conf" ]; then
    echo "ERROR: iotistic.conf NOT found!"
    exit 1
fi

LOCAL_CONF="conf/local.conf"

if ! grep -q "IotisticOS Configuration" "$LOCAL_CONF"; then
  echo "Adding IotisticOS configuration to local.conf..."
  cat >> "$LOCAL_CONF" <<EOF

# ======================================
# IotisticOS Configuration
# ======================================

DISTRO = "iotistic"
MACHINE = "${MACHINE}"

DL_DIR = "${DL_DIR}"
SSTATE_DIR = "${SSTATE_DIR}"

BB_NUMBER_THREADS = "4"
PARALLEL_MAKE = "-j 4"

IMAGE_FEATURES:append = " read-only-rootfs"

# Boot settings (ignored on non-RPi machines)
RPI_USE_U_BOOT = "1"
ENABLE_UART = "1"

PACKAGE_CLASSES = "package_ipk"
EXTRA_IMAGE_FEATURES:append = " package-management"

EXTRA_IMAGE_FEATURES:append = " debug-tweaks ssh-server-openssh"

INHERIT += "rm_work"

LICENSE_FLAGS_ACCEPTED:append = " commercial"
EOF
else
  echo "IotisticOS configuration already present."
fi

echo ""
echo "=== Verifying DISTRO/MACHINE settings ==="
grep -E "^DISTRO|^MACHINE|^PACKAGE_CLASSES" "$LOCAL_CONF"

echo ""
echo "=== Verifying iotistic.conf ==="
grep "PACKAGE_CLASSES" ../../meta-iotistic/conf/distro/iotistic.conf || echo "No PACKAGE_CLASSES inside distro conf"

echo ""
echo "=== Enforcing IPK with highest priority ==="
sed -i '/^PACKAGE_CLASSES/d' "$LOCAL_CONF"
cat >> "$LOCAL_CONF" <<EOF

# Force IPK globally with highest priority
PACKAGE_CLASSES:forcevariable = "package_ipk"
EOF

echo ""
echo "Final PACKAGE_CLASSES setting:"
grep "PACKAGE_CLASSES" "$LOCAL_CONF" | tail -1

echo "✓ Build configuration complete"