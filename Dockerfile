# The gatetest.io website + the sandbox worker, as one image (docker-compose
# runs it twice with different commands, next to postgres). This is NOT the
# CLI: `npx -p @gatetest/cli gatetest` needs no image. Operating notes and
# every env var the container reads: docs/ops/docker.md.
#
# Pinned to a specific Node minor AND its digest so two builds a month apart
# see the same base. Bump deliberately: `docker pull node:22-alpine`, read
# the version and digest, change both here.
FROM node:22.23.2-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
# git: the hosted scan seeds a throwaway repo in its workspace
# (website/app/lib/cli-engine-runner.js). curl: the HEALTHCHECK below.
RUN apk add --no-cache git curl

# ── engine deps ────────────────────────────────────────────────────────────
# The CLI engine (src/) has its own runtime dependencies in the ROOT
# lockfile. `npm ci` from the lockfile, production only, no lifecycle
# scripts — and no `|| true`: a failed install is a failed build.
FROM base AS engine-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── builder ────────────────────────────────────────────────────────────────
FROM base AS builder
# The website's `prebuild` stamps the commit into build-info.json so a stale
# deploy is visible at /api/platform-status. There is no .git in the build
# context (see .dockerignore), so the SHA arrives as a build-arg — the script
# reads GIT_COMMIT before it tries git. `docker build --build-arg
# GIT_COMMIT=$(git rev-parse HEAD) .`; compose passes it from the shell.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
# Emit .next/standalone — opt-in in next.config.ts because `next start` on
# the box cannot serve a standalone build.
ENV NEXT_OUTPUT_STANDALONE=1
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY website/package.json website/package-lock.json ./website/
RUN cd website && npm ci
# Everything the website build reaches outside website/: the engine it
# bundles for the hosted scan routes, the shared lib/, the two prebuild
# scripts, and CLAUDE.md (generate-build-info.js reads the version from it).
COPY package.json CLAUDE.md ./
COPY scripts/generate-build-info.js scripts/generate-changelog.js ./scripts/
COPY src ./src
COPY lib ./lib
COPY bin ./bin
COPY website ./website
RUN cd website && npm run build

# ── runner ─────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# next.config.ts traces from the REPO root, so the standalone tree mirrors
# the checkout: /app/website/server.js, /app/website/node_modules,
# /app/src (the traced engine), /app/node_modules (hoisted bits).
COPY --from=builder --chown=nextjs:nodejs /app/website/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/website/.next/static ./website/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/website/public ./website/public

# The whole engine, not only what the tracer kept: the hosted scan routes
# `require` src/index.js at runtime and it loads modules dynamically. lib/ is
# required from src/core; bin/ is the CLI the fix routes spawn.
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib
COPY --from=builder --chown=nextjs:nodejs /app/bin ./bin
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./
# Merged over the hoisted standalone node_modules (COPY into an existing
# directory adds files, it does not replace the directory).
COPY --from=engine-deps --chown=nextjs:nodejs /app/node_modules ./node_modules

# The worker (docker-compose `worker` service runs the same image with this
# as its command).
COPY --chown=nextjs:nodejs scripts/sandbox-worker.js ./scripts/

# Dispatches `docker run <image> --project /repo --suite quick` (CLI-flag
# arguments) to the bundled scan engine instead of the default website
# server; anything else execs unchanged. See docker-entrypoint.sh.
COPY --chown=nextjs:nodejs docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

USER nextjs

ENV NODE_ENV=production
ENV PORT=3000
# 0.0.0.0 is the container's own interface; publish it how you like.
ENV HOSTNAME=0.0.0.0

# Same probe docker-compose.yml declares, so a bare `docker run` reports
# health the same way `docker compose ps` does.
HEALTHCHECK --interval=10s --timeout=10s --start-period=30s --retries=6 \
  CMD curl -f http://localhost:3000/api/health || exit 1

EXPOSE 3000
WORKDIR /app/website
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
