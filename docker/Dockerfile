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

# PROCESS=api (default) | worker | migrate
ENV PROCESS=api
CMD ["sh", "-c", "\
  if [ \"$PROCESS\" = 'worker' ]; then \
    exec node -r @swc-node/register apps/worker/src/main.ts; \
  elif [ \"$PROCESS\" = 'migrate' ]; then \
    exec node -r @swc-node/register libs/database/src/migrate.ts; \
  else \
    exec node -r @swc-node/register apps/api/src/main.ts; \
  fi"]
