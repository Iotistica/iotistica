#!/bin/bash
set -euo pipefail

SYNC_DIR="$1"
REMOTE_URL="${2:-}"
INTERVAL_MINUTES="${3:-10}"
shift 3

if [ -z "$SYNC_DIR" ] || [ "$#" -eq 0 ]; then
  echo "Usage: $0 <sync-dir> <remote-url> <interval-minutes> <command...>"
  exit 1
fi

sync_once() {
  if [ -z "${REMOTE_URL:-}" ]; then
    return 0
  fi

  if [ ! -d "$SYNC_DIR" ] || [ -z "$(ls -A "$SYNC_DIR" 2>/dev/null)" ]; then
    echo "Skipping periodic sstate sync: $SYNC_DIR is empty"
    return 0
  fi

  echo "=== Syncing sstate to Azure Blob Storage ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ==="
  echo "Current sstate size: $(du -sh "$SYNC_DIR" 2>/dev/null || echo 'unknown')"

  azcopy sync "$SYNC_DIR/" "$REMOTE_URL" \
    --recursive=true \
    --delete-destination=false \
    --log-level=WARNING \
    --cap-mbps=500
}

periodic_sync_loop() {
  while true; do
    sleep "${INTERVAL_MINUTES}m"
    sync_once || echo "WARNING: Periodic sstate sync failed; continuing build"
  done
}

bg_pid=""

cleanup() {
  local exit_code=$?

  if [ -n "$bg_pid" ] && kill -0 "$bg_pid" 2>/dev/null; then
    kill "$bg_pid" 2>/dev/null || true
    wait "$bg_pid" 2>/dev/null || true
  fi

  sync_once || echo "WARNING: Final sstate sync failed"
  exit "$exit_code"
}

if [ -n "${REMOTE_URL:-}" ]; then
  echo "Starting periodic sstate sync every ${INTERVAL_MINUTES} minute(s)"
  periodic_sync_loop &
  bg_pid="$!"
  trap cleanup EXIT INT TERM
else
  echo "Azure sstate URL not set; running without periodic sync"
fi

"$@"