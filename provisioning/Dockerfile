# Billing Service - GitOps Provisioning
# Multi-stage build for optimized production image

# =============================================================================
# Stage 1: Builder - Compile TypeScript
# =============================================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for TypeScript compilation)
RUN npm ci

# Copy source code and TypeScript config
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# =============================================================================
# Stage 2: Provisioning API - REST API for customer management
# =============================================================================
FROM node:20-alpine AS provisioning

WORKDIR /app

# Install runtime dependencies only
# - postgresql-client: For database migrations
# - git: Required for simple-git library (GitOps operations)
# - bash: For entrypoint script
# - ca-certificates: For HTTPS connections (Stripe, Argo CD API)
# - curl: For health checks
RUN apk add --no-cache \
    postgresql-client \
    git \
    bash \
    ca-certificates \
    curl \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Install production dependencies only (no devDependencies)
RUN npm ci --only=production && npm cache clean --force

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Copy templates (needed at runtime)
COPY src/templates ./dist/templates

# Copy migrations
COPY migrations ./migrations

# Copy API migrations (used by create-template-db script)
COPY api-migrations ./api-migrations

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create keys directory (volume will be mounted here)
RUN mkdir -p /app/keys

# Create Git repository cache directory (for GitOps operations)
RUN mkdir -p /tmp/iot-k8s-main && chmod 777 /tmp/iot-k8s-main

# Create non-root user for security
RUN addgroup -g 1001 -S billing && \
    adduser -u 1001 -S billing -G billing && \
    chown -R billing:billing /app /tmp/iot-k8s-main

# Switch to non-root user
USER billing

# Environment
ENV NODE_ENV=production
ENV PORT=3100
ENV GITOPS_REPO_DIR=/tmp/iot-k8s-main

# Health check (using curl with silent mode)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3100/health || exit 1

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]

# =============================================================================
# Stage 3: Provisioning Worker - Background job processor
# =============================================================================
FROM node:20-alpine AS worker

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    postgresql-client \
    git \
    bash \
    ca-certificates \
    curl \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Copy templates (needed at runtime)
COPY src/templates ./dist/templates

# Copy migrations (worker may need to check DB state)
COPY migrations ./migrations

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create keys directory
RUN mkdir -p /app/keys

# Create Git repository cache directory
RUN mkdir -p /tmp/iot-k8s-main && chmod 777 /tmp/iot-k8s-main

# Create non-root user
RUN addgroup -g 1001 -S billing && \
    adduser -u 1001 -S billing -G billing && \
    chown -R billing:billing /app /tmp/iot-k8s-main

USER billing

# Environment
ENV NODE_ENV=production
ENV GITOPS_REPO_DIR=/tmp/iot-k8s-main

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/worker.js"]
