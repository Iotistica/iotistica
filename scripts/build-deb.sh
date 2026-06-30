#!/bin/sh
# Build a .deb package for the Iotistica Agent.
#
# Usage:
#   ./scripts/build-deb.sh <tarball> <version> <deb-arch>
#
#   <tarball>   Path to agent-<version>-<arch>.tar.gz
#   <version>   Package version, e.g. 1.0.526
#   <deb-arch>  Debian architecture: amd64 | arm64
#
# Output:
#   iotistica-agent_<version>_<arch>.deb  (same directory as the tarball)
#
# Example:
#   ./scripts/build-deb.sh /tmp/artifacts/agent-1.0.526-x86_64.tar.gz 1.0.526 amd64

set -e

TARBALL="$1"
VERSION="$2"
DEB_ARCH="$3"

if [ -z "$TARBALL" ] || [ -z "$VERSION" ] || [ -z "$DEB_ARCH" ]; then
    echo "Usage: $0 <tarball> <version> <deb-arch>"
    exit 1
fi

if [ ! -f "$TARBALL" ]; then
    echo "Error: tarball not found: $TARBALL"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DEB_SRC="$REPO_ROOT/agent/bin/deb"
OUT_DIR="$(dirname "$TARBALL")"
PKG_NAME="iotistica-agent_${VERSION}_${DEB_ARCH}"
PKG_DIR="/tmp/deb-build-${VERSION}-${DEB_ARCH}"

echo "Building .deb: $PKG_NAME"
echo "  Tarball : $TARBALL"
echo "  Version : $VERSION"
echo "  Arch    : $DEB_ARCH"

# ── Clean workspace ──────────────────────────────────────────────────────────

rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR/DEBIAN"
mkdir -p "$PKG_DIR/opt/iotistic/agent"
mkdir -p "$PKG_DIR/var/lib/iotistic/agent"
mkdir -p "$PKG_DIR/var/log/iotistic"
mkdir -p "$PKG_DIR/etc/iotistic"

# ── Default conffiles ────────────────────────────────────────────────────────
# dpkg requires every file listed in DEBIAN/conffiles to exist in the package.

cat > "$PKG_DIR/etc/iotistic/agent.env" << 'ENVEOF'
# Iotistica Agent configuration
# Edit this file and restart the service: systemctl restart iotistica-agent
#
# Leave IOTISTICA_API and PROVISIONING_KEY blank to run in standalone mode.
# Open the admin UI at http://<device-ip>:48481/admin/ to configure the device.

NODE_ENV=production
DEPLOYMENT_TYPE=systemd
DEVICE_API_PORT=48484
STANDALONE=true

# Cloud connectivity (optional — provision via admin UI instead)
IOTISTICA_API=
PROVISIONING_KEY=

# Logging
LOG_LEVEL=info
DATA_DIR=/var/lib/iotistic/agent
LOG_DIR=/var/log/iotistic
ENVEOF

# ── Extract agent files ───────────────────────────────────────────────────────

echo "Extracting agent files..."
tar -xzf "$TARBALL" -C "$PKG_DIR/opt/iotistic/agent" --strip-components=1

# ── DEBIAN control files ──────────────────────────────────────────────────────

# Compute installed size in KB (dpkg convention)
DEB_SIZE=$(du -sk "$PKG_DIR/opt" | cut -f1)

# Fill in placeholders in control
sed \
    -e "s/DEB_VERSION/$VERSION/g" \
    -e "s/DEB_ARCH/$DEB_ARCH/g" \
    -e "s/DEB_SIZE/$DEB_SIZE/g" \
    "$DEB_SRC/control" > "$PKG_DIR/DEBIAN/control"

# Copy and make scripts executable
for script in postinst prerm postrm conffiles; do
    if [ -f "$DEB_SRC/$script" ]; then
        cp "$DEB_SRC/$script" "$PKG_DIR/DEBIAN/$script"
        chmod 0755 "$PKG_DIR/DEBIAN/$script"
    fi
done
chmod 0644 "$PKG_DIR/DEBIAN/conffiles"

# ── Build ─────────────────────────────────────────────────────────────────────

DEB_FILE="$OUT_DIR/${PKG_NAME}.deb"
dpkg-deb --root-owner-group --build "$PKG_DIR" "$DEB_FILE"

echo "✓ Built: $DEB_FILE"
echo "  Size  : $(du -sh "$DEB_FILE" | cut -f1)"

# SHA256
sha256sum "$DEB_FILE" > "${DEB_FILE}.sha256"
echo "  SHA256: $(cat "${DEB_FILE}.sha256" | cut -d' ' -f1)"

# Cleanup
rm -rf "$PKG_DIR"
