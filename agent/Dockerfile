# ---- Shared base stage ----
FROM node:20-alpine3.22 AS base

WORKDIR /app

ENV npm_config_loglevel=warn \
    npm_config_progress=false

# Shared build dependencies (used by deps and builder stages)
# py3-setuptools provides distutils replacement for Python 3.12+
RUN apk add --no-cache \
    python3 py3-setuptools make g++ sqlite-dev linux-headers && \
    apk add --no-cache \
    --repository=https://dl-cdn.alpinelinux.org/alpine/edge/main \
    zlib=1.3.2-r0

# ---- Dependencies stage ----
FROM base AS deps

WORKDIR /app


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
FROM base AS builder

WORKDIR /app


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
# Build TypeScript using build-specific config
RUN npx tsc --project tsconfig.build.json && npm run copy:db-assets

# ---- Production stage ------
FROM node:20-alpine3.22 AS production

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

# Upgrade zlib to patched release from Alpine edge main.
RUN apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/edge/main zlib=1.3.2-r0
  

# Required for Tailscale state
VOLUME ["/var/lib/tailscale"]

# Create non-root user and group with explicit UID/GID for K8s compatibility
# Remove existing node user/group if present, then create agentuser with UID/GID 1000
RUN (deluser node || true) && \
    (delgroup node || true) && \
    addgroup -g 1000 agentgroup && \
    adduser -u 1000 -G agentgroup -s /bin/sh -D agentuser && \
    mkdir -p /app/data/vpn && \
    chown agentuser:agentgroup /app/data && \
    chown agentuser:agentgroup /app/data/vpn
   

# Copy package files from agent directory (contains version info)
COPY --chown=agentuser:agentgroup agent/package*.json ./

# Copy production dependencies from deps stage (already cleaned)
COPY --from=deps --chown=agentuser:agentgroup /app/node_modules ./node_modules

# Copy built application from builder stage
COPY --from=builder --chown=agentuser:agentgroup /app/dist ./dist

# Copy update scripts and entrypoint
COPY agent/bin/*.sh /app/bin/
COPY agent/docker-entrypoint.sh /app/docker-entrypoint.sh

# Set permissions on scripts and entrypoint
RUN chmod +x /app/bin/*.sh && \
    chmod +x /app/docker-entrypoint.sh

# Remove npm/npx from runtime image to reduce attack surface and npm-bundled CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx

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
