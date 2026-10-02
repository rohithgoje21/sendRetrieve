# syntax=docker/dockerfile:1

# ---- Dependencies (production only) ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Runtime ----
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY src ./src
COPY public ./public

# Uploaded files live here until object storage arrives; mount a volume to
# keep them across container restarts.
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" > /dev/null || exit 1

# Run node directly rather than through npm, so it receives SIGTERM and can
# shut down gracefully.
CMD ["node", "server.js"]
