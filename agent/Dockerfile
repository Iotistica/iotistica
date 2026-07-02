# ---- Build base stage (build tools only - never inherited by production) ----
FROM node:24-alpine AS build-base

WORKDIR /app

ENV npm_config_loglevel=warn \
    npm_config_progress=false

# Shared build dependencies (used by deps and builder stages)
# py3-setuptools provides distutils replacement for Python 3.12+
RUN apk add --no-cache \
    python3 py3-setuptools make g++ sqlite-dev linux-headers binutils

# ---- Dependencies stage ----
FROM build-base AS deps

WORKDIR /app


# Copy package files
COPY agent/package*.json ./

# Install production dependencies only - using cache mount
# Set PYTHON env var for node-gyp to find Python
# Add retry logic and longer timeouts for network issues
# --omit=optional skips native binaries and heavy extras for a smaller image
RUN --mount=type=cache,target=/root/.npm \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    PYTHON=python3 npm ci --omit=dev --legacy-peer-deps && \
    npm dedupe --omit=dev
RUN find node_modules -type d \( \
        -name test -o \
        -name tests -o \
        -name docs -o \
        -name example -o \
        -name examples \) \
        -prune -exec rm -rf {} + 2>/dev/null || true && \
    find node_modules -type f \( \
        -name "*.md" -o \
        -name "README*" -o \
        -name "*.ts" ! -name "*.d.ts" \) \
        -delete 2>/dev/null || true && \
    find node_modules -type f -name "*.node" -exec strip --strip-unneeded {} + 2>/dev/null || true

# ---- Build stage ----
FROM build-base AS builder

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
RUN npx tsc --project tsconfig.build.json && \
    npm run copy:db-assets && \
    find dist -name "*.map" -delete && \
    npm prune --omit=dev

# Pro package (optional — populated by generate-agents.ps1 -ProForce true / -Pro)
# Must run AFTER npm prune — prune removes unlisted packages from node_modules.
# Extract directly into node_modules so native deps (better-sqlite3, node-pty)
# are resolved from the agent's already-compiled node_modules tree.
COPY agent/pro/ /tmp/agent-pro/
RUN if ls /tmp/agent-pro/*.tgz 1>/dev/null 2>&1; then \
    echo "[Pro] Extracting @iotistica/agent-pro…" && \
    mkdir -p /app/node_modules/@iotistica/agent-pro && \
    tar -xzf /tmp/agent-pro/*.tgz -C /app/node_modules/@iotistica/agent-pro --strip-components=1 && \
    echo "[Pro] Installed"; \
    else echo "[Pro] No tarball found — Community build"; fi

# ---- Admin panel build stage ----
FROM node:24-alpine AS admin-builder

WORKDIR /app

COPY agent/admin/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY agent/admin ./
RUN npx vite build

# ---- Production stage ------
FROM node:24-alpine AS production

WORKDIR /app

# Install runtime dependencies and tini in single layer
# apk upgrade ensures patched versions of base packages (e.g. libcrypto3/libssl3)
RUN apk upgrade --no-cache && \
    apk add --no-cache \
    sqlite-libs \
    iptables \
    curl \
    jq \
    procps \
    tini \
    ca-certificates && \
    rm -rf /var/cache/apk/*



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

# Copy production dependencies from builder stage (pruned via npm prune --omit=dev)
COPY --from=builder --chown=agentuser:agentgroup /app/node_modules ./node_modules

# Copy built application from builder stage
COPY --from=builder --chown=agentuser:agentgroup /app/dist ./dist

# Copy built admin panel from admin-builder stage
COPY --from=admin-builder --chown=agentuser:agentgroup /app/dist ./admin/dist

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

# Container currently runs as root by default.
# Switch to non-root only after validating required runtime capabilities.
# USER agentuser

# Expose device API port
EXPOSE 48484

# Health check for device API
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:48484/health || exit 1

# Use tini as init process for proper signal handling
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]

# Start the agent
CMD ["node", "dist/app.js"]
