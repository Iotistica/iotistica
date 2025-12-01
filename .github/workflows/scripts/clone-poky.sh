#!/bin/bash
set -e

BUILD_DIR="$1"
YOCTO_VERSION="$2"

if [ -d "$BUILD_DIR/poky" ]; then
  echo "Poky exists, checking version..."
  cd "$BUILD_DIR/poky"
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  
  if [ "$CURRENT_BRANCH" != "$YOCTO_VERSION" ]; then
    echo "Branch mismatch: $CURRENT_BRANCH != $YOCTO_VERSION"
    echo "Removing old poky and cloning fresh..."
    cd "$BUILD_DIR"
    rm -rf poky
    git clone -b "$YOCTO_VERSION" git://git.yoctoproject.org/poky.git
  else
    echo "Poky already on correct branch, updating..."
    git fetch origin
    git reset --hard "origin/$YOCTO_VERSION"
  fi
else
  echo "Cloning Poky ($YOCTO_VERSION)..."
  cd "$BUILD_DIR"
  git clone -b "$YOCTO_VERSION" git://git.yoctoproject.org/poky.git
fi

echo "✓ Poky ready (branch: $YOCTO_VERSION)"
