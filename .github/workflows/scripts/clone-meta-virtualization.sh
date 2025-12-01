#!/bin/bash
set -e

BUILD_DIR="$1"
YOCTO_VERSION="$2"

echo "Cloning meta-virtualization layer for Docker support..."

cd "$BUILD_DIR"

if [ -d "meta-virtualization" ]; then
    echo "meta-virtualization already exists, updating..."
    cd meta-virtualization
    git fetch origin
    git checkout "$YOCTO_VERSION" || git checkout "master"
    git pull
else
    echo "Cloning meta-virtualization..."
    git clone https://git.yoctoproject.org/meta-virtualization
    cd meta-virtualization
    
    # Checkout matching branch for Yocto version
    if git ls-remote --heads origin | grep -q "refs/heads/$YOCTO_VERSION"; then
        git checkout "$YOCTO_VERSION"
        echo "✓ Checked out $YOCTO_VERSION branch"
    else
        echo "⚠ Branch $YOCTO_VERSION not found, using master"
        git checkout master
    fi
fi

echo "✓ meta-virtualization layer ready"
