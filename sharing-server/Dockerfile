# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────────────────
# Uses node:sqlite (built-in, no native compilation needed)
FROM node:24-slim@sha256:03eae3ef7e88a9de535496fb488d67e02b9d96a063a8967bae657744ecd513f2 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:production

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-slim@sha256:03eae3ef7e88a9de535496fb488d67e02b9d96a063a8967bae657744ecd513f2 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled bundle (no node_modules needed — no native deps)
COPY --from=builder /app/dist ./dist

RUN mkdir -p /data

VOLUME ["/data"]

EXPOSE 3000

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server.js"]
