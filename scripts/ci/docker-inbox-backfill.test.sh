#!/usr/bin/env bash
# #812 A-F-02: load both supported operator commands from the runtime image,
# without a checkout mount. Missing DATABASE_URL must reach our sanitized CLI
# failure handler, not fail on a missing entrypoint/import. DB behavior lives
# in notification-inbox.int.spec.ts.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }
IMAGE="${IMAGE:-gogo-be-inbox-packaging-test:local}"
if [[ -z "${IMAGE_PREBUILT:-}" ]]; then
  docker build -f docker/Dockerfile -t "$IMAGE" .
fi

probe() {
  local output status=0
  output=$("$@" 2>&1) || status=$?
  if [[ "$status" != 1 || "$output" != *"notification inbox rollout failed Error"* ]]; then
    echo "FAIL: packaged inbox CLI did not reach its startup validation (exit $status)" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  if [[ "$output" == *"Cannot find module"* || "$output" == *"MODULE_NOT_FOUND"* ]]; then
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

# No DB or network is needed to prove entrypoint/dependency packaging.
probe docker run --rm --network none -e DATABASE_URL= -e PROCESS=inbox-backfill "$IMAGE"
probe docker run --rm --network none -e DATABASE_URL= "$IMAGE" pnpm inbox:backfill
echo "PASS: both inbox backfill commands load inside the runtime image"
