# syntax=docker/dockerfile:1.7
#
# API server only. The UI is a static bundle (web/) uploaded to the platform's
# frontend host by CI — nothing in this image serves HTML.
#
# Four things about this host are load-bearing and each fails in a way that
# looks unrelated to the cause:
#
#   1. Listen on port 80, dual-stack. The container healthcheck runs INSIDE the
#      container against http://localhost:80, which resolves to ::1 first,
#      while the proxy connects from OUTSIDE over IPv4. Binding 0.0.0.0 alone
#      fails the healthcheck and the deploy is rolled back; binding IPv6 alone
#      passes the healthcheck and then 502s every real request. Node's `::` is
#      genuinely dual-stack — see server/http.ts, which defaults HOST to it.
#   2. Run as root. Binding port 80 is privileged; a `USER` line makes the
#      process die at startup with EACCES, which reads like any other crash.
#   3. A HEALTHCHECK, with curl actually present — alpine ships without it.
#   4. The HEALTHCHECK path must be the app's configured health_path
#      (/api/health), or whichever check runs is testing a route you didn't
#      mean.

# ---- deps -----------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---- build ----------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY scripts ./scripts
COPY lib ./lib
COPY server ./server
RUN npm run build

# ---- production dependencies ----------------------------------------------
# Separate from `deps` so esbuild and typescript don't ship to the runtime.
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime --------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# For the HEALTHCHECK below; Coolify tries curl, then wget.
RUN apk add --no-cache curl

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Carried into the runtime so /api/health can report the running commit.
ARG GIT_SHA=unknown
ENV BT_GATEWAY_COMMIT=$GIT_SHA

# Port 80 and a dual-stack bind — note 1 at the top of this file.
ENV PORT=80
ENV HOST="::"
EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
  CMD curl -fsS http://localhost:80/api/health || exit 1

# No USER line, on purpose — note 2 at the top of this file.
CMD ["node", "dist/server.js"]
