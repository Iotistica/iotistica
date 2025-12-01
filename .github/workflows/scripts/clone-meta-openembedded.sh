#!/bin/bash
set -e

BUILD_DIR="$1"
YOCTO_VERSION="$2"

echo "Cloning meta-openembedded layer..."

cd "$BUILD_DIR"

if [ -d "meta-openembedded" ]; then
    echo "meta-openembedded already exists, updating..."
    cd meta-openembedded
    git fetch origin
    git checkout "$YOCTO_VERSION" || git checkout "master"
    git pull
else
    echo "Cloning meta-openembedded..."
    git clone https://git.openembedded.org/meta-openembedded
    cd meta-openembedded
    
    # Checkout matching branch for Yocto version
    if git ls-remote --heads origin | grep -q "refs/heads/$YOCTO_VERSION"; then
        git checkout "$YOCTO_VERSION"
        echo "✓ Checked out $YOCTO_VERSION branch"
    else
        echo "⚠ Branch $YOCTO_VERSION not found, using master"
        git checkout master
    fi
fi

echo "✓ meta-openembedded layer ready"
echo "  Provides: meta-oe, meta-python, meta-networking, meta-filesystems"
