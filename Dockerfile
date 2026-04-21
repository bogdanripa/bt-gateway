# syntax=docker/dockerfile:1.7
#
# Multi-stage build for bt-gateway. Produces a slim runtime image by relying on
# Next.js's `output: 'standalone'` (see next.config.mjs) which traces just the
# production deps the server needs.
#
# Final image is ~150 MB and boots in ~300 ms on Cloud Run.

# ---- Stage 1: install deps ------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---- Stage 2: build -------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Accept the git SHA at build time; exposed at runtime via /api/health.
ARG GIT_SHA=unknown
ENV BT_GATEWAY_COMMIT=$GIT_SHA

RUN npm run build

# ---- Stage 3: runtime -----------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080

# Non-root user for the runtime process.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

# standalone server + trimmed node_modules + static assets
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Carry the commit SHA into runtime env so /api/health can report it.
ARG GIT_SHA=unknown
ENV BT_GATEWAY_COMMIT=$GIT_SHA

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
