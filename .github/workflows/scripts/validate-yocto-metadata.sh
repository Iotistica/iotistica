#!/bin/bash
set -euo pipefail

BUILD_DIR="$1"
YOCTO_VERSION="$2"

if [ -z "${BUILD_DIR}" ] || [ -z "${YOCTO_VERSION}" ]; then
  echo "Usage: $0 <build-dir> <yocto-version>"
  exit 1
fi

cd "$BUILD_DIR/poky"

if [ "$YOCTO_VERSION" = "kirkstone" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

set +u
source oe-init-build-env build
set -u

echo "=== Validating Yocto metadata ==="
bitbake -p
echo "✓ Yocto metadata parsed successfully"