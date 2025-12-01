#!/bin/bash
set -e

BUILD_DIR="$1"
DL_DIR="$2"

echo "Cleaning up old build artifacts..."

# Remove tmp directory
if [ -d "$BUILD_DIR/poky/build/tmp" ]; then
  echo "Removing tmp directory..."
  rm -rf "$BUILD_DIR/poky/build/tmp"
fi

# Clean old downloads (keep last 30 days)
find "$DL_DIR" -type f -mtime +30 -delete 2>/dev/null || true

echo "✓ Cleanup complete"
