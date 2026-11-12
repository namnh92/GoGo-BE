#!/usr/bin/env bash
# Astra round 1: overlay only the integration test on the detected buggy head.
set -euo pipefail
candidate_dir=$(git rev-parse --show-toplevel)
base_sha=$(git rev-parse --verify '3d296efd91469c227bd8fcc5bad04a9f723b8563^{commit}')
report_dir=${1:?Usage: bash scripts/eval/place-qa-s5-review-base.sh FRESH_REPORT_DIR}
mkdir -p "$report_dir"
report_dir=$(cd "$report_dir" && pwd -P)
if [[ -e "$report_dir/base.sha" ]]; then
  echo 'Use a fresh evidence directory.' >&2
  exit 2
fi
base_dir=$(mktemp -d "${TMPDIR:-/tmp}/place-qa-s5-review-base.XXXXXX")
trap 'rm -rf "$base_dir"' EXIT
git archive "$base_sha" | tar -x -C "$base_dir"
file=apps/api/test/place-aliases-s5.int.spec.ts
cp "$candidate_dir/$file" "$base_dir/$file"
shasum -a 256 "$candidate_dir/$file" > "$report_dir/overlay.sha256"
printf '%s\n' "$base_sha" > "$report_dir/base.sha"
cd "$base_dir"
set +e
CI=1 pnpm install --frozen-lockfile > "$report_dir/install.log" 2>&1
install_exit=$?
printf '%s\n' "$install_exit" > "$report_dir/install.exit"
if [[ $install_exit -ne 0 ]]; then exit "$install_exit"; fi
pnpm exec vitest run --project integration apps/api/test/place-aliases-s5.int.spec.ts \
  -t 'F-01|F-02' --reporter=default --reporter=json --outputFile="$report_dir/vitest.json" \
  > "$report_dir/test.log" 2>&1
test_exit=$?
printf '%s\n' "$test_exit" > "$report_dir/test.exit"
node --input-type=module - "$report_dir" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const dir = process.argv[2];
let tests = [];
try {
  tests = JSON.parse(readFileSync(`${dir}/vitest.json`, 'utf8')).testResults.flatMap(s => s.assertionResults);
} catch { /* Missing report is BLOCKED, never FAIL-before. */ }
const cases = [
  ['F-01 address:', 'FAIL_BEFORE'], ['F-01 hours:', 'FAIL_BEFORE'],
  ['F-01 compare:', 'FAIL_BEFORE'], ['F-02 transfer:', 'FAIL_BEFORE'],
  ['F-02 bound 21:', 'FAIL_BEFORE'], ['F-02 bound 20:', 'PASS_PRESERVED'],
];
const rows = cases.map(([prefix, expected]) => {
  const matches = tests.filter(t => t.title.startsWith(prefix));
  const t = matches.length === 1 ? matches[0] : undefined;
  const failures = t?.failureMessages ?? [];
  const status = t?.status === 'passed' ? 'PASS_PRESERVED'
    : t?.status === 'failed' && failures.length === 1
      && failures[0].includes('AssertionError: SYMPTOM:') ? 'FAIL_BEFORE' : 'BLOCKED';
  return { prefix, expected, status, failures };
});
const verified = rows.every(r => r.status === r.expected);
writeFileSync(`${dir}/review-proof.json`, JSON.stringify({
  baseSha: readFileSync(`${dir}/base.sha`, 'utf8').trim(),
  status: verified ? 'FAIL_BEFORE_VERIFIED' : 'INCOMPLETE', rows,
}, null, 2) + '\n');
process.exitCode = verified ? 0 : 1;
NODE
proof_exit=$?
printf '%s\n' "$proof_exit" > "$report_dir/proof.exit"
# A test-runner failure alone is not evidence. Exit 0 requires five symptom
# failures and the preserved 20-alias boundary, plus the expected Vitest exit.
if [[ $proof_exit -ne 0 ]]; then exit "$proof_exit"; fi
[[ $test_exit -eq 1 ]]
