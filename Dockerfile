# syntax=docker/dockerfile:1.7
#
# Multi-stage build for bt-gateway. Produces a slim runtime image by relying on
# Next.js's `output: 'standalone'` (see next.config.mjs) which traces just the
# production deps the server needs.
#
# The image is built for linux/arm64 by CI and runs on the Pi under Coolify.
# Four things about that host are load-bearing and easy to break by accident:
#
#   1. It must listen on port 80, dual-stack. The container healthcheck runs
#      INSIDE the container against http://localhost:80 (which resolves to ::1
#      first), while the proxy connects from OUTSIDE over IPv4. Binding only
#      0.0.0.0 fails the healthcheck and the deploy is rolled back; binding
#      only IPv6 passes the healthcheck and then 502s every real request.
#      Node's `::` bind is genuinely dual-stack, and Next's standalone server
#      reads its bind address from HOSTNAME — which Docker otherwise sets to
#      the container id, so setting it explicitly is required, not cosmetic.
#   2. It must run as root. Binding port 80 is privileged; a `USER` line makes
#      the process die at startup with EACCES.
#   3. It needs a HEALTHCHECK, and the base image must actually contain curl —
#      alpine does not ship it.
#   4. The HEALTHCHECK path must be the app's configured health_path
#      (/api/health). Pointing the two at different routes means whichever
#      check runs is testing something you didn't mean.

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

# curl is for the HEALTHCHECK below — alpine ships without it, and Coolify's
# check tries curl first, then wget.
RUN apk add --no-cache curl

# standalone server + trimmed node_modules + static assets
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Carry the commit SHA into runtime env so /api/health can report it.
ARG GIT_SHA=unknown
ENV BT_GATEWAY_COMMIT=$GIT_SHA

# Port 80 and a dual-stack bind — see note 1 at the top of this file.
ENV PORT=80
ENV HOSTNAME="::"
EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD curl -fsS http://localhost:80/api/health || exit 1

# No USER line, on purpose — see note 2 at the top of this file.
CMD ["node", "server.js"]
