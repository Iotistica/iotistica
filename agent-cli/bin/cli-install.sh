#!/bin/sh
# Iotistica CLI Installer - installs iotctl on the local machine
# Version: CLI_VERSION_PLACEHOLDER
#
# Usage (standalone):
#   curl -sfL https://get.iotistica.com/agent-cli | sh
#
# Usage (called from agent install.sh):
#   IOTISTICA_INSTALL_CLI=yes DOWNLOAD_BASE_URL=... sh cli-install.sh
#
# Environment variables:
#   IOTISTICA_CLI_VERSION        - CLI version to install (default: latest)
#   IOTISTICA_CLI_DOWNLOAD_URL   - Override full download URL
#   IOTISTICA_CLI_INSTALL_DIR    - Install directory for iotctl binary (default: /usr/local/bin)
#   IOTISTICA_CLI_LIB_DIR        - Directory for CLI runtime files (default: /opt/iotistic/cli)
#   DOWNLOAD_BASE_URL            - Base URL for agent artifacts; CLI URL is derived from this
#
# Exit codes:
#   0 - success
#   1 - error

set -e

CLI_VERSION_PLACEHOLDER="CLI_VERSION_PLACEHOLDER"
CLI_INSTALL_DIR="${IOTISTICA_CLI_INSTALL_DIR:-/usr/local/bin}"
CLI_LIB_DIR="${IOTISTICA_CLI_LIB_DIR:-/opt/iotistic/cli}"
CLI_VERSION="${IOTISTICA_CLI_VERSION:-latest}"

# Derive CLI download base from DOWNLOAD_BASE_URL if set by parent installer,
# otherwise fall back to the canonical CDN path.
if [ -n "$DOWNLOAD_BASE_URL" ]; then
    # Parent installer exports DOWNLOAD_BASE_URL like:
    #   https://get.iotistica.com/agent/artifacts
    # CLI artifacts live at:
    #   https://get.iotistica.com/agent-cli/artifacts
    CLI_DOWNLOAD_BASE="${DOWNLOAD_BASE_URL%/agent/artifacts}/agent-cli/artifacts"
else
    CLI_DOWNLOAD_BASE="https://get.iotistica.com/agent-cli/artifacts"
fi

echo ""
echo "=================================="
echo "Iotistica CLI (iotctl) Installer"
echo "=================================="

# Check for root
if [ "$(id -u)" -ne 0 ]; then
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64|amd64)
        TARBALL_SUFFIX="-x86_64"
        ;;
    aarch64|arm64)
        TARBALL_SUFFIX="-arm64"
        ;;
    armv7l|armhf)
        TARBALL_SUFFIX="-armhf"
        ;;
    *)
        echo "Warning: Unknown architecture $ARCH, attempting generic tarball"
        TARBALL_SUFFIX=""
        ;;
esac

echo "Architecture: $ARCH ($TARBALL_SUFFIX)"

# Resolve download URL
if [ -n "$IOTISTICA_CLI_DOWNLOAD_URL" ]; then
    DOWNLOAD_URL="$IOTISTICA_CLI_DOWNLOAD_URL"
elif [ "$CLI_VERSION" = "latest" ] || [ "$CLI_VERSION" = "dev" ]; then
    DOWNLOAD_URL="${CLI_DOWNLOAD_BASE}/cli-latest${TARBALL_SUFFIX}.tar.gz"
else
    DOWNLOAD_URL="${CLI_DOWNLOAD_BASE}/versions/cli-${CLI_VERSION}${TARBALL_SUFFIX}.tar.gz"
fi

echo "Downloading CLI from: $DOWNLOAD_URL"

# Download tarball
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$TMP_DIR/cli.tar.gz" "$DOWNLOAD_URL" || {
        echo "Error: Failed to download CLI from $DOWNLOAD_URL"
        exit 1
    }
elif command -v wget >/dev/null 2>&1; then
    wget -O "$TMP_DIR/cli.tar.gz" "$DOWNLOAD_URL" || {
        echo "Error: Failed to download CLI from $DOWNLOAD_URL"
        exit 1
    }
else
    echo "Error: Neither curl nor wget is available"
    exit 1
fi

echo "Extracting CLI..."
mkdir -p "$TMP_DIR/extracted"
tar -xzf "$TMP_DIR/cli.tar.gz" -C "$TMP_DIR/extracted" || {
    echo "Error: Failed to extract CLI tarball"
    exit 1
}

# Verify expected file exists
if [ ! -f "$TMP_DIR/extracted/dist/iotctl.js" ]; then
    echo "Error: dist/iotctl.js not found in tarball"
    echo "Contents:"
    find "$TMP_DIR/extracted" -name "*.js" | head -10
    exit 1
fi

# Install to lib dir
echo "Installing to $CLI_LIB_DIR..."
rm -rf "$CLI_LIB_DIR"
mkdir -p "$CLI_LIB_DIR"
cp -r "$TMP_DIR/extracted/." "$CLI_LIB_DIR/"

# Ensure the entry point is executable
chmod +x "$CLI_LIB_DIR/dist/iotctl.js"

# Create wrapper launcher in PATH instead of a JS symlink.
# Running a symlinked JS directly can break relative requires (e.g. ./core)
# because Node resolves them from /usr/local/bin instead of dist/.
LAUNCHER_PATH="$CLI_INSTALL_DIR/iotctl"
rm -f "$LAUNCHER_PATH"
cat > "$LAUNCHER_PATH" <<EOF
#!/bin/sh
exec node "$CLI_LIB_DIR/dist/iotctl.js" "\$@"
EOF
chmod +x "$LAUNCHER_PATH"

# Verify installation
if ! "$LAUNCHER_PATH" --version >/dev/null 2>&1; then
    echo "Warning: iotctl --version returned non-zero; launcher is in place but binary may need the agent running."
fi

echo "✓ iotctl installed to $LAUNCHER_PATH"
echo ""
echo "Try it:"
echo "  iotctl status"
echo "  iotctl device list"
