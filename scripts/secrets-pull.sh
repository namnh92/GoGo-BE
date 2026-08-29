#!/usr/bin/env bash
#
# Pull this environment's secrets from AWS SSM into .env.runtime.
#
#   pnpm secrets:pull            # dev
#   pnpm secrets:pull staging
#
# The values live in SSM and the puller lives in GoGo-Infra, because that
# repository owns secrets and this one owns the application. Keeping a second
# copy of the fetching logic here is how the two drift.

set -euo pipefail

ENVIRONMENT="${1:-dev}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA="${GOGO_INFRA_PATH:-${REPO_ROOT}/../GoGo-Infra}"
PULLER="${INFRA}/scripts/secrets/pull.sh"

if [[ ! -x "$PULLER" ]]; then
  cat >&2 <<MSG
error: cannot find GoGo-Infra at ${INFRA}

  This script delegates to GoGo-Infra/scripts/secrets/pull.sh, which owns the
  SSM layout. It assumes the two repositories sit side by side.

  If yours are elsewhere:

    GOGO_INFRA_PATH=/path/to/GoGo-Infra pnpm secrets:pull ${ENVIRONMENT}
MSG
  exit 1
fi

"$PULLER" "$ENVIRONMENT" --out "${REPO_ROOT}/.env.runtime"

cat <<MSG

Wrote .env.runtime (mode 0600). It is gitignored.

DEV uses managed services — Neon, Upstash, R2 — so nothing needs to run locally:

  pnpm dev

A local PostgreSQL and Redis are available for offline work or infrastructure
debugging, and are not part of normal development:

  docker compose --profile full-local up
MSG
