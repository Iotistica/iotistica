# Stage 1: Dependencies (production only)
FROM node:20-alpine3.22 AS deps
WORKDIR /app

RUN apk upgrade --no-cache

# Copy package files for dependency installation
COPY package*.json ./

# Install production dependencies only with clean cache
RUN npm ci --only=production && \
    npm cache clean --force

# Stage 2: Builder
FROM node:20-alpine3.22 AS builder
WORKDIR /app

RUN apk upgrade --no-cache

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci && \
    npm cache clean --force


# Copy TypeScript config and source code
COPY tsconfig*.json ./
COPY src ./src
COPY database ./database

# Build the application
RUN npm run build

# Stage 3: Production runtime
FROM node:20-alpine3.22 AS production
WORKDIR /app

# Install runtime system dependencies in single layer with cleanup
# Added ca-certificates and iptables for Tailscale support
RUN apk upgrade --no-cache && \
    apk add --no-cache \
    curl \
    tini \
    ca-certificates \
    iptables \
    ip6tables && \
    rm -rf /var/cache/apk/* && \
    rm -rf /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Install Tailscale (optional - only if API needs to join tailnet)
# For most deployments, API only needs the Admin API (no client install needed)
# Uncomment if you want the API container itself to join the tailnet:
# RUN wget -qO- https://tailscale.com/install.sh | sh

# Create non-root user and group
RUN addgroup -S appgroup && \
    adduser -S appuser -G appgroup

# Copy production dependencies from deps stage
COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules

# Copy built application from builder stage
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/database ./database

# Copy package files for runtime reference
COPY --chown=appuser:appgroup package*.json ./

# Create writable dirs
RUN mkdir -p /app/logs && \
    chown appuser:appgroup /app/logs && \
    chown appuser:appgroup /app && \
    # Create spool directory for circuit-breaker disk fallback.
    # Must be created here (owned by appuser) so the Docker named volume
    # inherits correct ownership on first mount. Without this the volume is
    # created as root and appuser gets EACCES at runtime.
    mkdir -p /var/lib/iotistic/spool && \
    chown -R appuser:appgroup /var/lib/iotistic


# Switch to non-root user
USER appuser

# Expose application port
EXPOSE 3002

# Health check to verify API is responding
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3002/health || exit 1

# Use tini as init process for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]

# Increase Node.js heap size for high load (100+ agents)
# Set to 75% of container memory limit (1536MB of 2GB) to leave room for:
# - Non-heap memory (buffers, native modules)
# - OS overhead and page cache
# - Safety margin to prevent OOM killer
ENV NODE_OPTIONS="--max-old-space-size=1536"

# Start the application
CMD ["node", "dist/index.js"]
