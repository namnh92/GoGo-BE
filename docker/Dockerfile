# GoGo backend runtime image — api and worker share it (PROCESS selects).
# MVP runtime executes TypeScript via @swc-node/register (same path as dev):
# internal workspace packages export TS source, so a plain tsc build cannot
# run standalone. Bundled build is a later optimization (noted in ADR-0001).
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Native build deps for argon2 / @swc/core prebuilds fallback.
RUN apk add --no-cache python3 make g++ libc6-compat

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
# Every workspace package's manifest, or `pnpm install` never links that
# package's dependencies. libs/cost-observability was split out in #403 without
# a line here; the image built, the tests passed, and the API crash-looped on
# the first DEV deploy with `Cannot find module 'drizzle-orm'` from inside it.
# The list below is the workspace — adding a package means adding a line.
COPY libs/cost-observability/package.json libs/cost-observability/package.json
COPY libs/database/package.json libs/database/package.json
COPY libs/modules/package.json libs/modules/package.json
COPY libs/observability/package.json libs/observability/package.json
COPY libs/providers/package.json libs/providers/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps ./apps
COPY libs ./libs
COPY migrations ./migrations
COPY openapi ./openapi

ENV NODE_ENV=production
ENV SWC_NODE_PROJECT=/app/tsconfig.base.json

# PROCESS=api (default) | worker | migrate | seed
#
# seed is here rather than left to a command override so the entry points this
# image offers stay this repository's to name. A deploy pipeline that spells out
# libs/database/src/seed.ts breaks silently when the file moves.
ENV PROCESS=api
CMD ["sh", "-c", "\
  if [ \"$PROCESS\" = 'worker' ]; then \
    exec node -r @swc-node/register apps/worker/src/main.ts; \
  elif [ \"$PROCESS\" = 'migrate' ]; then \
    exec node -r @swc-node/register libs/database/src/migrate.ts; \
  elif [ \"$PROCESS\" = 'seed' ]; then \
    exec node -r @swc-node/register libs/database/src/seed.ts; \
  else \
    exec node -r @swc-node/register apps/api/src/main.ts; \
  fi"]
