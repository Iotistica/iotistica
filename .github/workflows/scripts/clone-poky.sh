#!/bin/bash
set -euo pipefail

BUILD_DIR="$1"
YOCTO_VERSION="$2"
POKY_REMOTE="https://git.yoctoproject.org/poky.git"

if [ -z "${BUILD_DIR}" ] || [ -z "${YOCTO_VERSION}" ]; then
  echo "Usage: $0 <build-dir> <yocto-version>"
  exit 1
fi

if [ -d "$BUILD_DIR/poky" ]; then
  echo "Poky exists, checking version..."
  cd "$BUILD_DIR/poky"
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  
  if [ "$CURRENT_BRANCH" != "$YOCTO_VERSION" ]; then
    echo "Branch mismatch: $CURRENT_BRANCH != $YOCTO_VERSION"
    echo "Removing old poky and cloning fresh..."
    cd "$BUILD_DIR"
    rm -rf poky
    git clone -b "$YOCTO_VERSION" "$POKY_REMOTE"
  else
    echo "Poky already on correct branch, updating..."
    git fetch --tags origin
    git checkout "$YOCTO_VERSION"
    git pull --ff-only origin "$YOCTO_VERSION"
  fi
else
  echo "Cloning Poky ($YOCTO_VERSION)..."
  cd "$BUILD_DIR"
  git clone -b "$YOCTO_VERSION" "$POKY_REMOTE"
fi

echo "✓ Poky ready (branch: $YOCTO_VERSION)"
