#!/bin/bash
set -e

echo "=== Disk Space Before Build ==="
df -h

# Yocto needs at least 50GB free (minimum), 100GB recommended
AVAILABLE=$(df -BG /opt | tail -1 | awk '{print $4}' | sed 's/G//')
if [ "$AVAILABLE" -lt 50 ]; then
  echo "❌ Insufficient disk space: ${AVAILABLE}GB available, 50GB minimum required"
  exit 1
fi

if [ "$AVAILABLE" -lt 100 ]; then
  echo "⚠️  Limited disk space: ${AVAILABLE}GB available (100GB recommended)"
  echo "Build may succeed but watch for disk space issues"
else
  echo "✓ Sufficient disk space: ${AVAILABLE}GB available"
fi
