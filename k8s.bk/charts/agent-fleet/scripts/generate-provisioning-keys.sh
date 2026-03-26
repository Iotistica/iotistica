#!/usr/bin/env bash
#
# Generate provisioning keys for agent fleet deployment
#
# Usage: ./generate-provisioning-keys.sh <count> [api_url] [auth_token]
#
# Example:
#   ./generate-provisioning-keys.sh 100 https://api.iotistic.com $TOKEN
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
COUNT="${1:-10}"
API_URL="${2:-https://api.iotistic.com}"
FLEET_ID="${3:-k8s-fleet-default}"
AUTH_TOKEN="${4:-}"

# Validate count
if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [ "$COUNT" -lt 1 ]; then
    echo -e "${RED}Error: COUNT must be a positive integer${NC}" >&2
    exit 1
fi

echo -e "${YELLOW}Generating $COUNT provisioning keys...${NC}" >&2

# Check if API is accessible
if ! curl -s -f "${API_URL}/health" > /dev/null 2>&1; then
    echo -e "${RED}Error: API endpoint ${API_URL} is not accessible${NC}" >&2
    exit 1
fi

# Temporary file for keys
TEMP_FILE=$(mktemp)
trap "rm -f $TEMP_FILE" EXIT

# Generate keys
echo -e "${GREEN}Requesting keys from ${API_URL}...${NC}" >&2

SUCCESS=0
FAILED=0

for i in $(seq 0 $((COUNT - 1))); do
    # Show progress every 10 keys
    if [ $((i % 10)) -eq 0 ]; then
        echo -e "${YELLOW}Progress: $i/$COUNT keys generated...${NC}" >&2
    fi
    
    # Make API request
    if [ -n "$AUTH_TOKEN" ]; then
        RESPONSE=$(curl -s -X POST "${API_URL}/api/v1/provisioning-keys/generate" \
            -H "Authorization: Bearer ${AUTH_TOKEN}" \
            -H "Content-Type: application/json" \
            -d '{"fleetUuid": "'${FLEET_ID}'", "newKey": false, "metadata": {"index": '${i}'}}')
    else
        RESPONSE=$(curl -s -X POST "${API_URL}/api/v1/provisioning-keys/generate" \
            -H "Content-Type: application/json" \
            -d '{"fleetUuid": "'${FLEET_ID}'", "newKey": false, "metadata": {"index": '${i}'}}')  
    if [ -n "$KEY" ] && [ "$KEY" != "null" ]; then
        echo "PROVISIONING_KEY_${i}=${KEY}" >> "$TEMP_FILE"
        SUCCESS=$((SUCCESS + 1))
    else
        echo -e "${RED}Failed to generate key $i: $RESPONSE${NC}" >&2
        FAILED=$((FAILED + 1))
    fi
done

echo -e "${GREEN}Successfully generated: $SUCCESS keys${NC}" >&2
if [ $FAILED -gt 0 ]; then
    echo -e "${RED}Failed to generate: $FAILED keys${NC}" >&2
fi

# Output keys to stdout
cat "$TEMP_FILE"

echo -e "${GREEN}Keys saved. Use with:${NC}" >&2
echo -e "${YELLOW}kubectl create secret generic agent-provisioning-keys --from-env-file=<(./generate-provisioning-keys.sh $COUNT) -n agent-fleet${NC}" >&2
