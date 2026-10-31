# syntax=docker/dockerfile:1
# LiteForeFlow - Docker edition. One image, three roles: LITEFOREFLOW_ROLE=all | api | worker  (see docker-compose.yml)

# --- 1) build the editor (the browser app) ---------------------------------------------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- 2) install the server's runtime packages ------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# The toolchain is only used if isolated-vm has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

# --- 3) the small final image ----------------------------------------------------------------------------------
FROM node:24-bookworm-slim
# Small young generation + capped heap keep memory low. The strong code sandbox is mandatory in the Docker edition.
ENV NODE_ENV=production DATA_DIR=/data \
    NODE_OPTIONS="--max-semi-space-size=2 --max-old-space-size=192" \
    LITEFOREFLOW_REQUIRE_STRONG_SANDBOX=true
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY server server
COPY plugins plugins
COPY --from=web /build/web/dist web/dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
