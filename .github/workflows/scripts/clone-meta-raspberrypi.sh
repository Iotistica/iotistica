#!/bin/bash
set -e

BUILD_DIR="$1"
YOCTO_VERSION="$2"

if [ -d "$BUILD_DIR/meta-raspberrypi" ]; then
  echo "meta-raspberrypi already cloned, updating..."
  cd "$BUILD_DIR/meta-raspberrypi"
  git fetch origin
  git checkout "$YOCTO_VERSION"
  git pull origin "$YOCTO_VERSION"
else
  echo "Cloning meta-raspberrypi ($YOCTO_VERSION)..."
  cd "$BUILD_DIR"
  git clone -b "$YOCTO_VERSION" https://github.com/agherzan/meta-raspberrypi.git
fi

echo "✓ meta-raspberrypi ready"
