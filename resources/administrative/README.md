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

## Boundaries (ADM-007, #460)

`current-boundaries` is the one pinned input that is **not** vendored here.
`vn_provinces_wards_geojson.zip` is 47.6 MB compressed, 629 MB expanded, and
3,355 files; committing it would put half a gigabyte of coordinates into every
clone and every CI checkout, forever, for a file that changes about once a year.

The pin therefore moves from the bytes to two things that together give the same
guarantee:

- **the fetch URL names an immutable commit**, never a tag — a tag can be
  re-pointed, `b092d6b4…` cannot;
- **the SHA-256 is verified before a single entry is read**, so if the host ever
  served different bytes the load fails closed.

What is lost is availability, not integrity, and availability is not on the
request path: nothing fetches this at API startup, the loader is an operational
step (`pnpm db:boundaries`), and the resolver reads polygons out of PostgreSQL.
A machine with no network loads from a cached copy or from
`ADMINISTRATIVE_BOUNDARY_ARCHIVE=/path/to/archive.zip`.

`boundaries-fixture.v5.0.0.zip` **is** committed: five real, unmodified entries
taken from that archive (Hà Nội with Ba Đình and Ngọc Hà, Đà Nẵng with Hoàng
Sa), 64 KB. Every loader and resolver test runs offline against genuine geometry
— two communes that share a border, an offshore special zone, and a province
carrying only some of its communes.

Boundaries ship at **v5.0.0, the same tag as `current-units`**. Issue #460
assumed a separate v4.0.0 GIS release; that predates this archive, and the two
agree exactly — 34/34 provinces, 3,321/3,321 communes, zero parent
disagreements. The resolver's cross-release hierarchy check stays anyway,
because "they agree today" is a measurement, not a guarantee.
