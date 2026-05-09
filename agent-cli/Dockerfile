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

# Make iotctl executable
RUN chmod +x dist/iotctl.js && \
	ln -sf /app/dist/iotctl.js /usr/local/bin/iotctl

ENTRYPOINT ["node", "dist/iotctl.js"]
CMD ["help"]
