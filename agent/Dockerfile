# ---- Dependencies stage ----
FROM node:20-alpine AS deps

WORKDIR /app

# Install build tools needed for native dependencies (sqlite3)
RUN apk add --no-cache python3 make g++ sqlite-dev

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

# Install build tools for native deps (Alpine uses apk)
RUN apk add --no-cache make g++ sqlite-dev

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
    tini && \
    rm -rf /var/cache/apk/*

# Create non-root user and group early
RUN addgroup -S agentgroup && \
    adduser -S agentuser -G agentgroup && \
    mkdir -p /app/data/vpn && \
    chown -R agentuser:agentgroup /app

# Copy package files
COPY --chown=agentuser:agentgroup package*.json ./

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

# TEMPORARY: Run as root for development to avoid volume permission issues
# TODO: For production, use init container or entrypoint script to fix permissions
# USER agentuser

# Expose device API port
EXPOSE 48484

# Health check for device API
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:48484/health || exit 1

# Use tini as init process for proper signal handling
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]

# Start the agent with security revert flag for node-opcua compatibility
CMD ["node", "--security-revert=CVE-2023-46809", "dist/app.js"]
