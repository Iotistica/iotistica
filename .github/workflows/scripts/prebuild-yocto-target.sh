#!/bin/bash
set -euo pipefail

BUILD_DIR="$1"
YOCTO_VERSION="$2"
TARGET="$3"

if [ -z "${BUILD_DIR}" ] || [ -z "${YOCTO_VERSION}" ] || [ -z "${TARGET}" ]; then
  echo "Usage: $0 <build-dir> <yocto-version> <bitbake-target>"
  exit 1
fi

cd "$BUILD_DIR/poky"

if [ "$YOCTO_VERSION" = "kirkstone" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

set +u
source oe-init-build-env build
set -u

echo "=== Prebuilding Yocto target: $TARGET ==="
bitbake "$TARGET"
echo "✓ Prebuild complete for target: $TARGET"