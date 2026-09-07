# Pinned administrative snapshots

Inputs for the GoGo administrative dataset (ADR-0019, ADM-002 / #455). Read
`manifest.json` for the exact repository, tag, commit, path, SHA-256, licence
and expected counts of each.

## Why the bytes are vendored rather than fetched

A migration and a build must produce the same dataset next year as today. An
upstream tag can be re-pointed and a raw URL can change what it serves; a file
in this directory cannot. The importer verifies each SHA-256 against the
**decompressed** bytes before parsing and refuses to run on a mismatch.

Files are gzipped with `-9 -n` — no timestamp, no original filename — so the
compressed artefact is byte-stable and a re-vendor of identical input produces
an identical file. The pinned checksum is always of the _raw_ content, never of
the `.gz`, so the pin stays comparable with the upstream file.

## No runtime process reads these

They are synchronisation inputs for an offline import. **No GoGo runtime process
calls a public administrative API**, and none reads this directory. The API
serves what was imported, validated, reviewed and published.

## Licences

Both upstreams are MIT and both licence texts are vendored beside the data
(`LICENSE.*.txt`). Commercial use is permitted; the copyright notices travel
with the data, which is what those files are for.

## Re-pinning

Changing any file here changes the combined dataset identity. Update
`manifest.json` in the same commit, re-run the importer, and take the result
through validation, diff and review like any other dataset — a new snapshot is
never published because it is newer.
