#!/bin/bash
set -euo pipefail

MIN_DISK_GB="${1:-${MIN_DISK_GB:-30}}"
RECOMMENDED_DISK_GB="${2:-${RECOMMENDED_DISK_GB:-50}}"

if ! [[ "$MIN_DISK_GB" =~ ^[0-9]+$ ]] || ! [[ "$RECOMMENDED_DISK_GB" =~ ^[0-9]+$ ]]; then
  echo "❌ Invalid disk threshold values. Usage: $0 [min_gb] [recommended_gb]"
  exit 1
fi

echo "=== Disk Space Before Build ==="
df -h

# Yocto builds are heavy; thresholds are configurable per runner profile.
AVAILABLE=$(df -BG /opt | tail -1 | awk '{print $4}' | sed 's/G//')
if [ "$AVAILABLE" -lt "$MIN_DISK_GB" ]; then
  echo "❌ Insufficient disk space: ${AVAILABLE}GB available, ${MIN_DISK_GB}GB minimum required"
  exit 1
fi

if [ "$AVAILABLE" -lt "$RECOMMENDED_DISK_GB" ]; then
  echo "⚠️  Limited disk space: ${AVAILABLE}GB available (${RECOMMENDED_DISK_GB}GB recommended)"
  echo "Build may succeed but watch for disk space issues"
else
  echo "✓ Sufficient disk space: ${AVAILABLE}GB available"
fi
