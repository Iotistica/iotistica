#!/bin/bash
set -e

AGENT_VERSION_INPUT="$1"

if [ -n "$AGENT_VERSION_INPUT" ]; then
  AGENT_VERSION="$AGENT_VERSION_INPUT"
else
  AGENT_VERSION=$(jq -r '.version' agent/package.json)
fi

echo "agent_version=$AGENT_VERSION" >> $GITHUB_OUTPUT
echo "Building with agent version: $AGENT_VERSION"
