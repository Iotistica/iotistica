#!/usr/bin/env bash
# Enable discovered devices in the agent database for sensor publishing
#
# Usage: ./enable-discovered-devices.sh [--pod POD_NAME] [--namespace NAMESPACE] [--protocol PROTOCOL] [--dry-run]

set -euo pipefail

# Defaults
POD_NAME=""
NAMESPACE="agent-fleet-test"
PROTOCOL=""
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --pod)
      POD_NAME="$2"
      shift 2
      ;;
    --namespace|-n)
      NAMESPACE="$2"
      shift 2
      ;;
    --protocol|-p)
      PROTOCOL="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--pod POD_NAME] [--namespace NAMESPACE] [--protocol PROTOCOL] [--dry-run]"
      exit 1
      ;;
  esac
done

# Find agent pod if not specified
if [[ -z "$POD_NAME" ]]; then
  echo "🔍 Finding agent pod..."
  POD_NAME=$(kubectl get pods -n "$NAMESPACE" -o json | jq -r '.items[] | select(.metadata.name | contains("agent")) | .metadata.name' | head -n1)
  
  if [[ -z "$POD_NAME" ]]; then
    echo "❌ No agent pod found in namespace '$NAMESPACE'"
    exit 1
  fi
  
  echo "✓ Found pod: $POD_NAME"
fi

echo ""
echo "📊 Current Device Status:"
echo "============================================================"

# Show current status
STATUS_QUERY="SELECT id, name, protocol, enabled, datetime(lastSeenAt/1000, 'unixepoch') as last_seen FROM device_endpoints ORDER BY protocol, id;"

kubectl exec -n "$NAMESPACE" "$POD_NAME" -c agent -- sqlite3 /app/data/agent.db "$STATUS_QUERY"

echo ""

# Build WHERE clause
if [[ -n "$PROTOCOL" ]]; then
  WHERE_CLAUSE="WHERE protocol = '$PROTOCOL'"
else
  WHERE_CLAUSE="WHERE 1=1"
fi

if [[ "$DRY_RUN" == true ]]; then
  echo "🔍 DRY RUN - Would enable these devices:"
  
  DRY_RUN_QUERY="SELECT id, name, protocol, enabled FROM device_endpoints $WHERE_CLAUSE AND enabled = 0;"
  
  kubectl exec -n "$NAMESPACE" "$POD_NAME" -c agent -- sqlite3 /app/data/agent.db "$DRY_RUN_QUERY"
  
  echo ""
  echo "⚠️  No changes made (dry run mode)"
  exit 0
fi

# Actually enable devices
echo "🔧 Enabling discovered devices..."

UPDATE_QUERY="UPDATE device_endpoints SET enabled = 1 $WHERE_CLAUSE AND enabled = 0;"

kubectl exec -n "$NAMESPACE" "$POD_NAME" -c agent -- sqlite3 /app/data/agent.db "$UPDATE_QUERY"

# Count enabled devices
COUNT_QUERY="SELECT COUNT(*) FROM device_endpoints WHERE enabled = 1;"
ENABLED_COUNT=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -c agent -- sqlite3 /app/data/agent.db "$COUNT_QUERY")

echo ""
echo "✅ Enabled devices successfully!"
echo "📊 Total enabled devices: $ENABLED_COUNT"

echo ""
echo "📊 Updated Device Status:"
echo "============================================================"

kubectl exec -n "$NAMESPACE" "$POD_NAME" -c agent -- sqlite3 /app/data/agent.db "$STATUS_QUERY"

echo ""
echo "💡 Next steps:"
echo "  1. Wait for agent to reload endpoints (~30s auto-reconciliation)"
echo "  2. Check logs for 'Sensor Publish feature' initialization"
echo "  3. Monitor MQTT topics: sensor/{protocol}/{name}/{metric}"
echo ""
echo "  Watch logs:"
echo "    kubectl logs -f $POD_NAME -c agent -n $NAMESPACE | grep -i 'sensor'"
