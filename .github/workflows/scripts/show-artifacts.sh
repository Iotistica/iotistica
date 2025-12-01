#!/bin/bash
set -e

BUILD_DIR="$1"
MACHINE="$2"

cd "$BUILD_DIR/poky/build"

echo "=== Build Artifacts ==="
ls -lh "tmp/deploy/images/$MACHINE/"

# Find the image file
IMAGE_FILE=$(ls "tmp/deploy/images/$MACHINE/"*.wic.bz2 2>/dev/null || \
             ls "tmp/deploy/images/$MACHINE/"*.rootfs.ext4 2>/dev/null || \
             echo "No image found")

if [ "$IMAGE_FILE" != "No image found" ]; then
  IMAGE_SIZE=$(du -h "$IMAGE_FILE" | cut -f1)
  echo "✓ Image: $(basename "$IMAGE_FILE") ($IMAGE_SIZE)"
else
  echo "⚠ No standard image format found"
fi
