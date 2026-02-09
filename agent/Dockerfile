# ---- Dependencies stage ----
FROM node:20-alpine AS deps

WORKDIR /app

# Install build tools needed for native dependencies (sqlite3, node-pty)
# py3-setuptools provides distutils replacement for Python 3.12+
RUN apk add --no-cache python3 py3-setuptools make g++ sqlite-dev linux-headers

# Copy package files
COPY agent/package*.json ./

# Install production dependencies only - using cache mount
# Set PYTHON env var for node-gyp to find Python
# Add retry logic and longer timeouts for network issues
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    PYTHON=python3 npm ci --omit=dev --legacy-peer-deps

# ---- Build stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install build tools for native deps (sqlite3, node-pty)
# py3-setuptools provides distutils replacement for Python 3.12+
RUN apk add --no-cache python3 py3-setuptools make g++ sqlite-dev linux-headers

# Copy package files
COPY agent/package*.json agent/tsconfig.json agent/tsconfig.build.json ./

# Install all deps (including dev) - using cache mount for faster builds
# Set PYTHON env var for node-gyp to find Python
# Add retry logic and longer timeouts for network issues
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    PYTHON=python3 npm ci --legacy-peer-deps

# Copy source code and shared config
COPY agent/src ./src
COPY agent/cli ./cli

# Build TypeScript using build-specific config (excludes CLI)
RUN npx tsc --project tsconfig.build.json && npm run copy:migrations 

# Build CLI separately
RUN npx tsc cli/iotctl.ts --outDir dist/cli --module commonjs --target es2020

# ---- Production stage ------
FROM node:20-alpine AS production

WORKDIR /app

# Install runtime dependencies and tini in single layer
RUN apk add --no-cache \
    sqlite-libs \
    iptables \
    curl \
    jq \
    procps \
    tini  \
    tailscale \
    ca-certificates && \
    rm -rf /var/cache/apk/* 
  

# Required for Tailscale state
VOLUME ["/var/lib/tailscale"]

# Create non-root user and group with explicit UID/GID for K8s compatibility
RUN addgroup -g 1000 agentgroup && \
    adduser -u 1000 -G agentgroup -s /bin/sh -D agentuser && \
    mkdir -p /app/data/vpn && \
    chown -R agentuser:agentgroup /app

# Copy package files from agent directory (contains version info)
COPY --chown=agentuser:agentgroup agent/package*.json ./

# Copy production dependencies from deps stage (already cleaned)
COPY --from=deps --chown=agentuser:agentgroup /app/node_modules ./node_modules

# Copy built application from builder stage
COPY --from=builder --chown=agentuser:agentgroup /app/dist ./dist

# Copy update scripts and entrypoint
COPY agent/bin/*.sh /app/bin/
COPY agent/docker-entrypoint.sh /app/docker-entrypoint.sh

# Create iotctl symlink and set permissions
RUN chmod +x /app/dist/cli/iotctl.js && \
    chmod +x /app/bin/*.sh && \
    chmod +x /app/docker-entrypoint.sh && \
    ln -s /app/dist/cli/iotctl.js /usr/local/bin/iotctl

# Data volume for persistent storage
VOLUME ["/app/data"]

# IMPORTANT: Container must run as root for Tailscale VPN to work
# Tailscale requires:
#   - Root privileges for iptables/network configuration
#   - /dev/net/tun device access
#   - NET_ADMIN capability
# 
# Docker run example:
#   docker run --cap-add=NET_ADMIN --device=/dev/net/tun:/dev/net/tun <image>
# 
# Docker Compose example:
#   cap_add:
#     - NET_ADMIN
#   devices:
#     - /dev/net/tun:/dev/net/tun
#
# USER agentuser  # Disabled - must run as root for Tailscale

# Expose device API port
EXPOSE 48484

# Health check for device API
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:48484/health || exit 1

# Use tini as init process for proper signal handling
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]

# Start the agent with security revert flag for node-opcua compatibility
CMD ["node", "--security-revert=CVE-2023-46809", "dist/app.js"]
