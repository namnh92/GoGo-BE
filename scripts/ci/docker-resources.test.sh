#!/usr/bin/env bash
# #487 — the pinned administrative snapshots must be in the runtime image.
#
# The defect this guards against is invisible to every other test in this
# repository, and that is the whole point: integration tests run against the
# checkout, where `resources/` is always present. Only a container shows the
# hole. On 2026-09-08 DEV answered every administrative import with
#
#   ENOENT: no such file or directory, open '/app/resources/administrative/manifest.json'
#
# after a deploy whose CI was entirely green.
#
# So this test never reads the repository. It builds the production image, runs
# a script INSIDE it with no bind mount and from a working directory that is not
# /app, and asks PinnedSnapshotReader itself — the same class the import path
# uses — to resolve, read and checksum every vendored snapshot. If it can do
# that in the container, the import can.
#
#   ./scripts/ci/docker-resources.test.sh              # builds the image
#   IMAGE=gogo-be:some-tag ./scripts/ci/docker-resources.test.sh   # reuses one
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$here" || exit 2

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }

IMAGE="${IMAGE:-gogo-be-packaging-test:local}"

if [[ -z "${IMAGE_PREBUILT:-}" ]]; then
  echo "==> building ${IMAGE} from docker/Dockerfile"
  docker build -f docker/Dockerfile -t "$IMAGE" . >/tmp/gogo-packaging-build.log 2>&1 || {
    echo "FAIL  image build" >&2; tail -30 /tmp/gogo-packaging-build.log >&2; exit 1; }
fi

# Piped in on stdin and written to the container's own /tmp. No volume, no bind
# mount: nothing the repository contains is reachable from inside this run, so a
# pass cannot come from the checkout.
#
# --workdir / on purpose. ADMINISTRATIVE_RESOURCES resolves from the module's
# __dirname rather than the process working directory, and the import runs from
# whatever directory the entrypoint chose. Proving it from `/` proves the
# resolution does not depend on where the process happens to start.
read -r -d '' PROBE <<'JS'
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mod = require('/app/libs/modules/administrative/application/pinned-snapshot.reader.ts');
const { PinnedSnapshotReader, ADMINISTRATIVE_RESOURCES } = mod;

// 1. The directory the reader resolves is the one inside the image.
assert.strictEqual(
  ADMINISTRATIVE_RESOURCES,
  '/app/resources/administrative',
  `reader resolves ${ADMINISTRATIVE_RESOURCES}, expected /app/resources/administrative`,
);
console.log(`ok    reader resolves ${ADMINISTRATIVE_RESOURCES} (cwd is ${process.cwd()})`);

// 2. manifest.json exists and parses, read through the reader rather than fs.
const reader = new PinnedSnapshotReader();
const manifest = reader.manifest();
assert.ok(Array.isArray(manifest.sources) && manifest.sources.length > 0, 'manifest has no sources');
console.log(`ok    manifest.json readable — ${manifest.sources.length} sources declared`);

// 3. Every source the manifest declares as vendored is present, and its
//    checksum validates. `read()` throws SnapshotChecksumError on drift, so a
//    silent corruption cannot pass here.
//
//    A source carrying `fetchUrl` is deliberately NOT vendored — the boundary
//    archive is 629 MB expanded and is fetched at load time against the same
//    pin. Its file must be absent; asserting that keeps this test honest about
//    which files the image is supposed to carry.
let vendored = 0;
for (const source of manifest.sources) {
  const file = path.join(ADMINISTRATIVE_RESOURCES, source.vendoredAs);
  if (source.fetchUrl) {
    assert.ok(!fs.existsSync(file), `${source.vendoredAs} carries fetchUrl but is vendored in the image`);
    console.log(`ok    ${source.role}: not vendored by design (fetchUrl), absent as expected`);
    continue;
  }
  assert.ok(fs.existsSync(file), `${source.vendoredAs} is missing from the image`);
  // The integrity guarantee, and the only one the manifest actually makes about
  // content: sha256 over the DECOMPRESSED bytes. `read()` throws
  // SnapshotChecksumError on any drift, so a corrupted or substituted file
  // cannot pass here.
  //
  // Deliberately NOT asserting `content.length === source.bytes`. A first draft
  // did, and historical-units failed it — 2,500,493 decompressed against
  // `bytes: 2451968` — while its checksum verified. `bytes` describes the file
  // upstream serves, not the decompressed payload, so equality is a constraint
  // the data never promised. Reported instead of asserted.
  const content = reader.read(source);
  assert.ok(content.length > 0, `${source.vendoredAs} decompressed to nothing`);
  vendored += 1;
  console.log(
    `ok    ${source.role}: ${source.vendoredAs} present, sha256 verified ` +
      `(${content.length} bytes decompressed, manifest bytes: ${source.bytes})`,
  );
}
assert.ok(vendored >= 3, `expected at least 3 vendored snapshots, verified ${vendored}`);

// 4. Licence files the manifest names travel with the data they cover.
for (const name of new Set(manifest.sources.map((s) => s.licenseFile).filter(Boolean))) {
  assert.ok(fs.existsSync(path.join(ADMINISTRATIVE_RESOURCES, name)), `${name} is missing from the image`);
  console.log(`ok    licence present: ${name}`);
}

// 5. The path the import actually takes. readJson() is what
//    AdministrativeImportService calls first, and it is where #487 threw.
const { source, data } = reader.readJson('current-units');
assert.ok(data && typeof data === 'object', 'current-units did not parse as JSON');
console.log(`ok    readJson('current-units') works — the call that returned ENOENT on #487`);
if (source.expected) {
  console.log(`      manifest expects ${JSON.stringify(source.expected)}`);
}

console.log(`\nok    packaging verified inside the image: ${vendored} vendored snapshots`);
JS

echo "==> probing inside ${IMAGE} (no bind mount, --workdir /)"
# NODE_PATH and the absolute loader path are what make --workdir / survivable:
# from `/`, node would resolve neither `@swc-node/register` nor anything else in
# /app/node_modules. Preloading it by absolute path keeps the working directory
# free to be somewhere other than /app, which is the property under test.
if printf '%s' "$PROBE" | docker run --rm -i --workdir / --network none \
     -e NODE_PATH=/app/node_modules "$IMAGE" \
     sh -c 'cat > /tmp/probe.cjs && node -r /app/node_modules/@swc-node/register /tmp/probe.cjs'; then
  echo "PASS  administrative resources are in the runtime image"
  exit 0
else
  echo "FAIL  administrative resources are missing or corrupt in the runtime image" >&2
  echo "      This is #487: docker/Dockerfile must COPY resources ./resources." >&2
  exit 1
fi
