#!/usr/bin/env bash
# Run the candidate's identical Layer A oracle against base production code.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 || ${1:-} == --help ]]; then
  echo "Usage: $0 <base-sha> [report-directory]"
  echo "Requires Docker/Testcontainers and offline pnpm dependencies. Returns the harness exit code."
  [[ ${1:-} == --help ]] && exit 0
  exit 2
fi
candidate_dir=$(git rev-parse --show-toplevel)
base_sha=$(git -C "$candidate_dir" rev-parse --verify "${1}^{commit}")
report_dir=${2:-$(mktemp -d "${TMPDIR:-/tmp}/place-qa-base-report.XXXXXX")}
mkdir -p "$report_dir"
report_dir=$(cd "$report_dir" && pwd -P)
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/place-qa-base.XXXXXX")
base_dir="$temp_dir/worktree"
cleanup() {
  git -C "$candidate_dir" worktree remove --force "$base_dir" >> "$report_dir/worktree.log" 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT
# This explicit allowlist is the complete overlay. No libs implementation,
# migrations, config, ops SQL, package manifest or candidate node_modules is copied.
overlay=(
  apps/api/test/assistant-place-qa-s3.int.spec.ts
  libs/modules/assistant/eval/place-qa-cases.vi.json
  libs/modules/assistant/eval/place-qa-fixtures.json
  libs/modules/search/eval/intent-cases.vi.json
  apps/api/test/support/assistant-fixture.ts
  apps/api/test/support/place-name-key.ts
  apps/api/test/support/credit-events.ts
  apps/api/test/support/cms-access.ts
  apps/api/test/support/pg-shutdown.ts
)
git -C "$candidate_dir" worktree add --detach "$base_dir" "$base_sha" > "$report_dir/worktree.log" 2>&1
for file in "${overlay[@]}"; do
  mkdir -p "$base_dir/$(dirname "$file")"
  cp "$candidate_dir/$file" "$base_dir/$file"
done
# Hash both copies and reject any accidental production overlay. Record the
# candidate diff digest as well: an uncommitted harness is not identified by HEAD.
node - "$candidate_dir" "$base_dir" "$report_dir" "$base_sha" "${overlay[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const [candidate, base, report, baseSha, ...files] = process.argv.slice(2);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args]);
const changed = git(base, ['status', '--porcelain', '--untracked-files=all']).toString().trimEnd().split('\n').filter(Boolean).map(line => line.slice(3));
if (changed.some(file => !files.includes(file))) throw new Error('Non-test file changed on base');
const hashes = files.map(file => {
  const sha256 = digest(fs.readFileSync(path.join(candidate, file)));
  if (sha256 !== digest(fs.readFileSync(path.join(base, file)))) throw new Error(`Overlay mismatch: ${file}`);
  return { file, sha256 };
});
fs.writeFileSync(path.join(report, 'overlay.json'), JSON.stringify({
  baseSha, candidateHeadSha: git(candidate, ['rev-parse', 'HEAD']).toString().trim(),
  candidateDiffSha256: digest(git(candidate, ['diff', '--binary', 'HEAD'])), files: hashes,
}, null, 2));
NODE
cd "$base_dir"
# Install in base so @gogo/* workspace links target base production, never head.
set +e
CI=1 pnpm install --offline --frozen-lockfile > "$report_dir/install.log" 2>&1
install_exit=$?
test_exit=0
if [[ $install_exit -eq 0 ]]; then
  PLACE_QA_BASELINE=1 PLACE_QA_BASE_SHA="$base_sha" PLACE_QA_HEAD_SHA="$base_sha" \
  PLACE_QA_REPORT="$report_dir/cases.json" \
    pnpm -s vitest run --project integration --no-file-parallelism \
    apps/api/test/assistant-place-qa-s3.int.spec.ts \
    --reporter=default --reporter=json --outputFile="$report_dir/vitest.json" \
    > "$report_dir/test.log" 2>&1
  test_exit=$?
fi
set -e
node - "$report_dir" "$install_exit" "$test_exit" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [dir, install, test] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'overlay.json'), 'utf8'));
const casesPath = path.join(dir, 'cases.json');
const cases = fs.existsSync(casesPath) ? JSON.parse(fs.readFileSync(casesPath, 'utf8')) : null;
const counts = {};
for (const c of cases?.cases ?? []) {
  const key = `${c.category}:${c.result}${c.result === 'FAIL' ? ':' + c.phase : ''}`;
  counts[key] = (counts[key] ?? 0) + 1;
}
fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
  ...manifest, installExit: Number(install), testExit: Number(install) === 0 ? Number(test) : null,
  status: Number(install) !== 0 ? 'INSTALL_FAILED' : cases?.status ?? 'HARNESS_NOT_EXECUTED', counts,
}, null, 2));
NODE
echo "Base evidence: $report_dir/run.json (cases.json, vitest.json, install.log, test.log)"
if [[ $install_exit -ne 0 ]]; then exit "$install_exit"; fi
exit "$test_exit"
