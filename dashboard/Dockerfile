# Build stage
FROM node:20-alpine3.22 AS builder

# Patch base OS packages in build stage for image-layer vulnerability scans
RUN apk upgrade --no-cache

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build arguments
ARG NODE_ENV=production

# Set environment variables for Vite buildt
ENV NODE_ENV=$NODE_ENV

# Build the application (API URL will be configured at runtime via ConfigMap)
RUN npm run build

# Production stage
FROM nginx:1.28-alpine3.22

# Ensure runtime OS packages include latest security patches
RUN apk upgrade --no-cache

# Copy built assets from builder stage
COPY --from=builder /app/build /usr/share/nginx/html

# Copy nginx configuration for SPA routing
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/ || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
