#!/usr/bin/env bash
# Immutable S5 test/corpus overlay on baseline production. Requires Docker.
set -euo pipefail
candidate_dir=$(git rev-parse --show-toplevel)
base_sha=$(git rev-parse --verify "${1:-50c6691a}^{commit}")
report_dir=${2:-"$candidate_dir/docs/plans/887-evidence/base"}
mkdir -p "$report_dir"
report_dir=$(cd "$report_dir" && pwd -P)
if [[ -e "$report_dir/base.sha" ]]; then
  echo "Use a fresh report directory to preserve evidence and avoid stale results." >&2
  exit 2
fi
base_dir=$(mktemp -d "${TMPDIR:-/tmp}/place-qa-s5-base.XXXXXX")
trap 'rm -rf "$base_dir"' EXIT
git archive "$base_sha" | tar -x -C "$base_dir"
# No candidate production code, migration or configuration is copied.
: > "$report_dir/overlay.sha256"
for file in apps/api/test/place-aliases-s5.int.spec.ts libs/modules/assistant/eval/place-qa-cases.s5.vi.json; do
  mkdir -p "$base_dir/$(dirname "$file")"
  cp "$candidate_dir/$file" "$base_dir/$file"
  shasum -a 256 "$candidate_dir/$file" >> "$report_dir/overlay.sha256"
done
printf '%s\n' "$base_sha" > "$report_dir/base.sha"
cd "$base_dir"
set +e
# DEV may fetch missing tarballs; an incomplete offline store is not proof.
CI=1 pnpm install --frozen-lockfile > "$report_dir/install.log" 2>&1
install_exit=$?
printf '%s\n' "$install_exit" > "$report_dir/install.exit"
if [[ $install_exit -ne 0 ]]; then exit "$install_exit"; fi
PLACE_QA_S5_BASELINE=1 pnpm -s vitest run --project integration apps/api/test/place-aliases-s5.int.spec.ts \
  --reporter=default --reporter=json --outputFile="$report_dir/vitest.json" > "$report_dir/test.log" 2>&1
test_exit=$?
printf '%s\n' "$test_exit" > "$report_dir/test.exit"
# A nonzero exit alone is NOT FAIL-before. Verify all alias rows reached
# SYMPTOM assertions; infrastructure/admission failures are BLOCKED evidence.
node --input-type=module - "$report_dir" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const reportDir = process.argv[2];
const corpus = JSON.parse(readFileSync('libs/modules/assistant/eval/place-qa-cases.s5.vi.json', 'utf8'));
let assertions = [];
try {
  const report = JSON.parse(readFileSync(`${reportDir}/vitest.json`, 'utf8'));
  assertions = report.testResults.flatMap((suite) => suite.assertionResults);
} catch {
  // No test report (e.g. a runner/setup failure) cannot establish FAIL-before.
}
const rows = corpus.cases.flatMap((c) => [
  ['resolver', `${c.id}: ${c.category}`],
  ['public', `${c.id}: public question → SSE → history, zero models`],
].map(([layer, title]) => {
  const matches = assertions.filter((test) => test.title === title);
  const test = matches.length === 1 ? matches[0] : undefined;
  const failures = test?.failureMessages ?? [];
  const status = test?.status === 'passed' ? 'UNEXPECTED_PASS'
    : test?.status === 'failed' && failures.length === 1
      && failures[0].includes('AssertionError: SYMPTOM:') ? 'FAIL_BEFORE'
    : 'BLOCKED';
  return { id: c.id, category: c.category, layer, status, failures };
}));
const verified = rows.length === 24 && rows.every((row) => row.status === 'FAIL_BEFORE');
writeFileSync(`${reportDir}/alias-proof.json`, JSON.stringify({
  baseSha: readFileSync(`${reportDir}/base.sha`, 'utf8').trim(),
  status: verified ? 'FAIL_BEFORE_VERIFIED' : 'INCOMPLETE',
  rows,
}, null, 2) + '\n');
process.exitCode = verified ? 0 : 1;
NODE
proof_exit=$?
printf '%s\n' "$proof_exit" > "$report_dir/proof.exit"
if [[ $proof_exit -ne 0 ]]; then exit "$proof_exit"; fi
exit "$test_exit"
