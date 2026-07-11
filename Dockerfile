# Dockerfile
# Container image for the hosted deploy (DESIGN.md § Hosted deployment).
#
# Multi-stage build. better-sqlite3 does NOT resolve a prebuilt binary on
# node:20-slim and falls back to compiling from source via node-gyp, which
# needs Python 3, make, and a C++ compiler — none of which belong in the
# runtime image. sharp has no such problem (it installs prebuilt
# @img/sharp-linux-x64 npm packages, no compile step). So: a builder stage
# carries the node-gyp toolchain just long enough to run `npm ci`, and the
# final stage copies the already-compiled node_modules into a clean
# node:20-slim with no toolchain at all. Both stages share the same glibc
# base, so the compiled better-sqlite3 .node file runs unmodified in the
# final stage.

FROM node:20-slim AS build

WORKDIR /app

# node-gyp toolchain: only needed here, in the stage that runs `npm ci`.
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Dependencies first, source after: an edit to src/ or docs/ does not bust the
# npm ci layer, so rebuilds during development stay fast.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

FROM node:20-slim

WORKDIR /app

# Bring over the compiled node_modules (including better-sqlite3's native
# .node binary, built against this same glibc base) plus the source tree.
# No compiler toolchain in this stage — that's the point of splitting it out.
COPY --from=build /app /app

# The app writes into data/ and backups/ on every boot (src/app.js creates
# data/* subdirectories; scripts/backup.js writes into backups/). Both are
# bind-mount targets (docker-compose.yml), but the directories must exist and
# be owned by the non-root user before USER node takes effect below.
RUN mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups

# Run as the non-root `node` user (built into the base image, uid 1000) —
# never the container default of root.
USER node

ENV NODE_ENV=production

# The app listens on 3000 INSIDE the container, always — this is not the
# env-settable PORT from config.js. Changing the host-facing port is done by
# remapping the host side of the compose `ports:` entry (e.g. "8080:3000"),
# not by setting PORT — see docs/deploy.md's environment-variable table and
# "PORT and the container path" note. EXPOSE below and the HEALTHCHECK probe
# must always agree with this: both stay pinned to 3000, and CMD below never
# reads config.PORT internally either.
EXPOSE 3000

# The platform's process supervisor needs a liveness/readiness signal.
# GET /healthz (src/app.js) runs a live `SELECT 1` against SQLite and returns
# 200/503 accordingly (DESIGN.md § Hosted deployment, issue #282).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/app.js"]
