# syntax=docker/dockerfile:1.7
#
# API server only. The UI is a static bundle (web/) uploaded to the platform's
# frontend host by CI — nothing in this image serves HTML.
#
# ## Why the build stages pin --platform=$BUILDPLATFORM
#
# The target is linux/arm64 and CI builds on an amd64 runner, so every RUN in
# an unpinned stage executes under QEMU emulation. Node under emulated arm64
# does not survive that: `npm ci` dies with
#
#     qemu: uncaught target signal 4 (Illegal instruction) - core dumped
#
# QEMU does not implement every instruction V8 emits. Pinning the install and
# bundle stages to $BUILDPLATFORM runs them natively on the builder instead —
# which also takes the build from tens of minutes to a couple, because nothing
# is being emulated.
#
# This is only safe because the production dependency tree is pure JavaScript:
# no *.node binaries, and no packages with `os`/`cpu` constraints outside
# devDependencies. Verify that still holds before adding a dependency:
#
#     npm ls --omit=dev --all --parseable | xargs -I{} find {} -name '*.node'
#
# If that ever returns something, the deps must be installed on the target
# platform (and QEMU worked around) rather than copied across.
#
# ## Host requirements — four things, each failing in a way that looks unrelated
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

# ---- deps (native on the builder) -----------------------------------------
FROM --platform=$BUILDPLATFORM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# ---- build (native on the builder) ----------------------------------------
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY scripts ./scripts
COPY lib ./lib
COPY server ./server
RUN npm run build

# ---- production dependencies (native on the builder) -----------------------
# Separate from `deps` so esbuild and typescript never reach the runtime.
FROM --platform=$BUILDPLATFORM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime (the actual target architecture) ------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# For the HEALTHCHECK below; Coolify tries curl, then wget. This is the only
# emulated step left, and apk is fine under QEMU where Node is not.
RUN apk add --no-cache curl

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Carried into the runtime so /api/health can report the running commit.
ARG GIT_SHA=unknown
ENV BT_GATEWAY_COMMIT=$GIT_SHA

# Port 80 and a dual-stack bind — requirement 1 at the top of this file.
ENV PORT=80
ENV HOST="::"
EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
  --start-interval=250ms \
  CMD curl -fsS http://localhost:80/api/health || exit 1

# No USER line, on purpose — requirement 2 at the top of this file.
CMD ["node", "dist/server.js"]
