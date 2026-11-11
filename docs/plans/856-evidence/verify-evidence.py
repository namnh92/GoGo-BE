"""Verify the review manifest, final content hashes and source snapshot; no Git required."""
from pathlib import Path
import hashlib
import re

root = Path(__file__).resolve().parents[3]
evidence = root / 'docs/plans/856-evidence'
manifest = (evidence / 'changed-files.txt').read_text().splitlines()
required = {
    'apps/api/src/assistant/assistant-stream-http.spec.ts',
    'libs/modules/assistant/presentation/assistant-stream.guard.ts',
    'libs/modules/assistant/presentation/assistant.controller.ts',
    'libs/modules/assistant/application/assistant-stream.spec.ts',
    'libs/modules/assistant/infrastructure/assistant.repository.ts',
    'libs/modules/assistant/domain/place-qa/reference-group.ts',
    'libs/modules/assistant/domain/place-tokens.ts',
    'libs/modules/src/index.ts',
    'openapi/gogo.v1.yaml',
    'openapi/gogo.v1.d.ts',
    'docs/plans/856-stream-admission.md',
}
assert required <= set(manifest), f'Missing final files: {sorted(required - set(manifest))}'
assert manifest == sorted(set(manifest)), 'Manifest must be sorted with no duplicates'
actual_evidence = {str(p.relative_to(root)) for p in evidence.iterdir() if p.is_file()}
assert actual_evidence <= set(manifest), f'Missing evidence: {actual_evidence - set(manifest)}'
hashes = dict(line.split('  ', 1)[::-1] for line in (evidence / 'files.sha256').read_text().splitlines())
assert set(hashes) == set(manifest) - {'docs/plans/856-evidence/files.sha256'}, 'Hash coverage differs from manifest'
for path, digest in hashes.items():
    assert hashlib.sha256((root / path).read_bytes()).hexdigest() == digest, f'Stale hash: {path}'
source_rows = ''.join(f'{hashes[path]}  {path}\n' for path in manifest if not path.startswith('docs/plans/856-evidence/'))
snapshot = hashlib.sha256(source_rows.encode()).hexdigest()
report = (evidence / 'validation.md').read_text()
assert f'Source snapshot: `{snapshot}`' in report, 'Validation is not bound to final source content'
# Every log the report cites exists, and every round-3 log is cited.
cited = set(re.findall(r'`(round-3-[a-z0-9-]+\.txt)`', report))
present = {p.name for p in evidence.glob('round-3-*.txt')}
assert cited == present, f'Report and round-3 logs differ: {sorted(cited ^ present)}'
for name in present:
    if 'fail-before' not in name:
        assert (evidence / name).read_text().rstrip().endswith('exit=0'), f'Gate log is not a pass: {name}'
print(f'PASS: {len(manifest)} manifest paths, {len(hashes)} content hashes; source snapshot {snapshot}')
