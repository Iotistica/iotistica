FROM node:20-alpine AS deps
WORKDIR /workspace/ingestion

COPY ingestion/package*.json ./

RUN npm ci --only=production && \
    npm cache clean --force

FROM node:20-alpine AS builder
WORKDIR /workspace/ingestion

COPY ingestion/package*.json ./

RUN npm ci && \
    npm cache clean --force

COPY ingestion/tsconfig.json ./tsconfig.json
COPY ingestion/src ./src

RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app

RUN apk upgrade --no-cache zlib && \
    apk add --no-cache \
    curl \
    tini \
    ca-certificates \
    iptables \
    ip6tables && \
    rm -rf /var/cache/apk/* && \
    rm -rf /usr/local/lib/node_modules/npm && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

RUN addgroup -S appgroup && \
    adduser -S appuser -G appgroup

COPY --from=deps --chown=appuser:appgroup /workspace/ingestion/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /workspace/ingestion/dist ./dist
COPY --chown=appuser:appgroup ingestion/package*.json ./

RUN mkdir -p /app/logs && \
    chown appuser:appgroup /app/logs && \
    chown appuser:appgroup /app && \
    mkdir -p /var/lib/iotistic/spool && \
    chown -R appuser:appgroup /var/lib/iotistic

USER appuser

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3003/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]

ENV NODE_OPTIONS="--max-old-space-size=1536"

CMD ["node", "dist/index.js"]