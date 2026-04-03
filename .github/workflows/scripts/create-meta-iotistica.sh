#!/bin/bash
set -e

BUILD_DIR="$1"

echo "Creating custom meta-iotistic layer..."

LAYER_DIR="$BUILD_DIR/meta-iotistic"
mkdir -p "$LAYER_DIR/conf"
mkdir -p "$LAYER_DIR/conf/distro"
mkdir -p "$LAYER_DIR/recipes-iotistic/agent"
mkdir -p "$LAYER_DIR/recipes-core/images"
mkdir -p "$LAYER_DIR/recipes-connectivity/networkmanager"
mkdir -p "$LAYER_DIR/recipes-support/resin-init"

# Layer configuration
cat > "$LAYER_DIR/conf/layer.conf" << 'EOF'
# We have a conf and classes directory, add to BBPATH
BBPATH .= ":${LAYERDIR}"

# We have recipes-* directories, add to BBFILES
BBFILES += "${LAYERDIR}/recipes-*/*/*.bb \
            ${LAYERDIR}/recipes-*/*/*.bbappend"

BBFILE_COLLECTIONS += "meta-iotistic"
BBFILE_PATTERN_meta-iotistic = "^${LAYERDIR}/"
BBFILE_PRIORITY_meta-iotistic = "6"

LAYERDEPENDS_meta-iotistic = "core"
LAYERSERIES_COMPAT_meta-iotistic = "kirkstone scarthgap"
EOF

# IotisticOS distro configuration
cat > "$LAYER_DIR/conf/distro/iotistic.conf" << 'EOF'
# IotisticOS - IoT distribution with container orchestration

require conf/distro/poky.conf

DISTRO = "iotistic"
DISTRO_NAME = "IotisticOS"
DISTRO_VERSION = "1.0.0"
DISTRO_CODENAME = "iotistic-core"

# Systemd as init system
DISTRO_FEATURES:append = " systemd"
DISTRO_FEATURES_BACKFILL_CONSIDERED = "sysvinit"
VIRTUAL-RUNTIME_init_manager = "systemd"
VIRTUAL-RUNTIME_initscripts = ""
VIRTUAL-RUNTIME_login_manager = "shadow-base"

# Use ipk package manager instead of RPM
PACKAGE_CLASSES = "package_ipk"

# Read-only root filesystem for reliability
IMAGE_FEATURES:append = " read-only-rootfs"

# Networking support with WiFi and Bluetooth
DISTRO_FEATURES:append = " wifi bluetooth"

# Container support
DISTRO_FEATURES:append = " virtualization"

# Security features
DISTRO_FEATURES:append = " pam"

# Remove unnecessary features for embedded
DISTRO_FEATURES:remove = "x11 wayland vulkan"
EOF

# Custom image recipe
cat > "$LAYER_DIR/recipes-core/images/iotistic-image.bb" << 'EOF'
SUMMARY = "IotisticOS - IoT platform image with container orchestration"
DESCRIPTION = "Minimal embedded Linux with agent-based container orchestration"
LICENSE = "MIT"

inherit core-image

# Base system packages
IMAGE_INSTALL:append = " \
    packagegroup-core-boot \
    packagegroup-base-wifi \
    ${CORE_IMAGE_EXTRA_INSTALL} \
"

# Systemd and init
IMAGE_INSTALL:append = " \
    systemd \
    dbus \
"

# Basic networking
IMAGE_INSTALL:append = " \
    wpa-supplicant \
    iproute2 \
    iputils \
"

# Docker container runtime (requires meta-virtualization layer)
# Note: docker-compose doesn't exist as a Yocto package
# It will be installed via npm in agent's postinstall script
IMAGE_INSTALL:append = " \
    docker \
"

# Agent runtime dependencies
IMAGE_INSTALL:append = " \
    nodejs \
    nodejs-npm \
"

# Container runtime essentials
IMAGE_INSTALL:append = " \
    curl \
    wget \
    ca-certificates \
"

# Development tools
IMAGE_INSTALL:append = " \
    openssh \
    openssh-sftp-server \
"

# Filesystem utilities
IMAGE_INSTALL:append = " \
    e2fsprogs \
    e2fsprogs-resize2fs \
    parted \
    dosfstools \
"

# Persistent data partition initialization
IMAGE_INSTALL:append = " \
    iotistic-init-datapartition \
"

# Read-only root with overlay for reliability
IMAGE_FEATURES:append = " read-only-rootfs"

# Extra space for applications
IMAGE_ROOTFS_EXTRA_SPACE = "524288"

# Boot partition size
BOOT_SPACE = "65536"

# WIC image for SD card deployment
IMAGE_FSTYPES = "wic.bz2 tar.bz2"
WKS_FILE = "iotistic-raspberrypi.wks"
EOF

# WIC partition layout
cat > "$LAYER_DIR/recipes-core/images/iotistic-raspberrypi.wks" << 'EOF'
# IotisticOS partition layout
part /boot --source bootimg-partition --ondisk mmcblk0 --fstype=vfat --label boot --active --align 4096 --size 64M
part / --source rootfs --ondisk mmcblk0 --fstype=ext4 --label rootfs --align 4096 --size 2G
part /data --ondisk mmcblk0 --fstype=ext4 --label data --align 4096 --size 4G
EOF

# Data partition init recipe
mkdir -p "$LAYER_DIR/recipes-support/resin-init/files"
cat > "$LAYER_DIR/recipes-support/resin-init/iotistic-init-datapartition.bb" << 'EOF'
SUMMARY = "Initialize persistent data partition"
LICENSE = "MIT"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"

SRC_URI = "file://iotistic-init-data.sh \
           file://iotistic-init-data.service"

inherit systemd

SYSTEMD_SERVICE:${PN} = "iotistic-init-data.service"
SYSTEMD_AUTO_ENABLE = "enable"

do_install() {
    install -d ${D}${sbindir}
    install -m 0755 ${WORKDIR}/iotistic-init-data.sh ${D}${sbindir}/
    
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${WORKDIR}/iotistic-init-data.service ${D}${systemd_system_unitdir}/
}
EOF

cat > "$LAYER_DIR/recipes-support/resin-init/files/iotistic-init-data.sh" << 'EOF'
#!/bin/sh
# Initialize /data partition on first boot

set -e

DATA_PARTITION="/dev/mmcblk0p3"
MOUNT_POINT="/data"

# Check if data partition exists
if [ ! -b "$DATA_PARTITION" ]; then
    echo "Data partition not found: $DATA_PARTITION"
    exit 0
fi

# Create mount point
mkdir -p "$MOUNT_POINT"

# Check if already formatted
if ! blkid "$DATA_PARTITION" | grep -q "TYPE="; then
    echo "Formatting data partition..."
    mkfs.ext4 -F -L data "$DATA_PARTITION"
fi

# Mount data partition
if ! mountpoint -q "$MOUNT_POINT"; then
    echo "Mounting data partition..."
    mount "$DATA_PARTITION" "$MOUNT_POINT"
fi

# Create application directories
mkdir -p /data/iotistic
mkdir -p /data/docker
mkdir -p /data/logs

# Check for boot partition provisioning (supports two formats)
# Format 1: Simple text file with just the key (easiest for manufacturing)
PROV_KEY_FILE="/boot/provisioning-key.txt"
if [ -f "$PROV_KEY_FILE" ]; then
    echo "Found provisioning key in /boot/provisioning-key.txt..."
    PROV_KEY=$(cat "$PROV_KEY_FILE" | tr -d '\n\r' | tr -d ' ')
    
    # Create JSON boot config for agent
    cat > /data/iotistic/boot-config.json << BOOTCONF
{
  "provisioningKey": "${PROV_KEY}"
}
BOOTCONF
    chmod 600 /data/iotistic/boot-config.json
    chown iotistic:iotistic /data/iotistic/boot-config.json
    
    # Securely delete the key file from boot partition (one-time use)
    rm -f "$PROV_KEY_FILE"
    echo "✓ Provisioning key configured, boot file removed"
fi

# Format 2: Full JSON config (supports additional parameters)
BOOT_CONFIG="/boot/iotistic-config.json"
if [ -f "$BOOT_CONFIG" ]; then
    echo "Found provisioning config in /boot/iotistic-config.json..."
    cp "$BOOT_CONFIG" /data/iotistic/boot-config.json
    chmod 600 /data/iotistic/boot-config.json
    chown iotistic:iotistic /data/iotistic/boot-config.json
    
    # Optionally delete from boot (comment out to keep)
    # rm -f "$BOOT_CONFIG"
    echo "✓ Provisioning config copied to /data"
fi

# Create symlinks from read-only locations to writable /data partition
# Agent will write to these paths, which redirect to /data
if [ ! -L /var/lib/iotistic ]; then
    rm -rf /var/lib/iotistic
    ln -s /data/iotistic /var/lib/iotistic
fi

if [ ! -L /var/log/iotistic ]; then
    rm -rf /var/log/iotistic
    ln -s /data/logs /var/log/iotistic
fi

# Set ownership for agent user
chown -R iotistic:iotistic /data/iotistic 2>/dev/null || true
chown -R iotistic:iotistic /data/logs 2>/dev/null || true

# Configure Docker to use /data partition
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << DOCKERCONF
{
  "data-root": "/data/docker",
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
DOCKERCONF

echo "Data partition initialized"
EOF

cat > "$LAYER_DIR/recipes-support/resin-init/files/iotistic-init-data.service" << 'EOF'
[Unit]
Description=Initialize IotisticOS data partition
DefaultDependencies=no
After=systemd-udev-settle.service
Before=local-fs.target
RequiresMountsFor=/data

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/iotistic-init-data.sh
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=local-fs.target
EOF

# Verify layer was created
echo ""
echo "=== Verifying meta-iotistic layer creation ==="
ls -la "$LAYER_DIR/conf/"
ls -la "$LAYER_DIR/conf/distro/"
echo ""
echo "iotistic.conf exists:" 
[ -f "$LAYER_DIR/conf/distro/iotistic.conf" ] && echo "✓ YES" || echo "❌ NO"
echo ""

echo "✓ meta-iotistic layer created"
