#!/bin/bash
set -e

BUILD_DIR="$1"
YOCTO_VERSION="$2"

cd "$BUILD_DIR/poky"

# Set Python 3.8 for kirkstone
if [ "$YOCTO_VERSION" = "kirkstone" ]; then
  echo "Configuring Python 3.8 for Yocto $YOCTO_VERSION"
  export PYTHON=/usr/bin/python3.8
  # Create a wrapper to ensure bitbake uses Python 3.8
  mkdir -p "$HOME/.local/bin"
  echo '#!/bin/bash' > "$HOME/.local/bin/python3"
  echo 'exec /usr/bin/python3.8 "$@"' >> "$HOME/.local/bin/python3"
  chmod +x "$HOME/.local/bin/python3"
  export PATH="$HOME/.local/bin:$PATH"
  python3 --version
fi

# Source Yocto environment
source oe-init-build-env build

echo "✓ Build environment initialized"
