# syntax=docker/dockerfile:1
# One image for the whole MERN app: the Express API (server/) serves the built
# React app (client/dist).

# ---- Build the React client ----
FROM node:24-alpine AS client
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --workspace client
COPY client client
RUN npm run build --workspace client

# ---- Server dependencies (production only) ----
FROM node:24-alpine AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --workspace server --omit=dev && npm cache clean --force \
    && mkdir -p server/node_modules

# ---- Runtime ----
FROM node:24-alpine
ENV NODE_ENV=production \
    CLIENT_DIR=/app/client/dist \
    UPLOAD_DIR=/app/uploads
WORKDIR /app

COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json server/server.js ./server/
COPY server/src ./server/src
# Admin tools, e.g. docker compose exec app node scripts/set-role.js <email> admin
COPY server/scripts ./server/scripts
COPY --from=client /app/client/dist ./client/dist

# Only used with STORAGE_DRIVER=disk; with object storage, files never touch
# this container.
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" > /dev/null || exit 1

# Run node directly rather than through npm, so it receives SIGTERM and can
# shut down gracefully.
WORKDIR /app/server
CMD ["node", "server.js"]
