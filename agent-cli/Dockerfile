FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig*.json ./
RUN npm ci --prefer-offline --no-audit

COPY src/ ./src/
RUN npm run build

# ---- Runtime ----
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --prefer-offline --no-audit

COPY --from=builder /app/dist ./dist

# Install iotctl launcher in PATH. A JS symlink at /usr/local/bin breaks
# relative requires (e.g. ./core) because Node resolves from symlink location.
RUN chmod +x dist/iotctl.js && \
	printf '#!/bin/sh\nexec node /app/dist/iotctl.js "$@"\n' > /usr/local/bin/iotctl && \
	chmod +x /usr/local/bin/iotctl

ENTRYPOINT ["node", "dist/iotctl.js"]
CMD ["help"]
