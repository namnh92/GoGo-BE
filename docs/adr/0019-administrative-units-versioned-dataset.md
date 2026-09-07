# ADR-0019: Administrative units are a versioned, reviewed, published dataset — and an address carries codes beside its names

- **Status:** accepted
- **Date:** 2026-09-07
- **Deciders:** Database, BFF/API, CMS Ops, Platform/SRE, repository owner
- **Supersedes in part:** ADR-0016 — its `places.city` / `places.district` clause, and only its conclusion
- **Constrained by:** the permanent Google-content freeze (`GoGo-BE/CLAUDE.md`, `GOGO_PRODUCT_DATA_ARCHITECTURE.md`) — resolved for this work by the owner decision on GoGo-BE#464, recorded in §10
- **Issues:** GoGo-BE#454 … #464; GoGo-CMS#153 … #156; GoGo-MobileApp#148; GoGo-Infra#156

## Context

Vietnam moved to a two-level administrative hierarchy on 2025-07-01:
province/municipality, then ward/commune/special zone. District-level units were
dissolved. Every address GoGo stored before that date names a unit that no
longer exists, and every address stored after it names one whose code GoGo does
not hold.

The MVP needs official administrative identifiers for consistent place
moderation, filtering and approval. Free-text `city` / `district` cannot do that
job: two editors write "TP.HCM" and "Thành phố Hồ Chí Minh" and the filter sees
two cities.

Five facts about the repository as it stands:

1. **There is no administrative-unit model.** `grep -ri administrative` across
   all six repos returns ADR-0016, the Google adapter's `addressComponents`
   passthrough, and generated OpenAPI types. This is greenfield.
2. **`places.city` / `places.district` are free-text names**, added by migration
   `0046_place-editor-contracts.sql` and decided in ADR-0016 on 2026-09-06 — one
   day before this ADR. Its reason: "Vietnamese administrative units are
   reorganised, editors need to type one the catalog does not carry, and minting
   a code for it would put a key in the data that resolves to nothing."
3. **`places.area_key` is a _discovery_ area, not an address** — the
   `service_areas` catalog (`hcm_q1`, `hcm_thuduc`), shared by six tables.
   ADR-0016 settled that it is deliberately not the postal address. Untouched
   here.
4. **The runtime holds no general-purpose read cache.** Redis is Upstash, billed
   per command and metered by the Cost Observability epic, used for rate
   limiting, session revocation and room events only. The session-revocation
   reader already sits behind an in-process cache for that reason.
5. **GoGo stores no Google address components.** `place_provider_sources` has no
   `addressComponents` and no `formattedAddress`; `place_sources.raw` was
   stopped and nulled by migration `0033`; no `PLACE_FIELD_MASKS` tier requests
   `addressComponents`.

## Decision

### 1. Names stay. Codes are added beside them.

`places.city`, `places.district` and `places.address_text` are **unchanged**:
free text, nullable, writable exactly as before, never removed, never retyped,
and **never overwritten by a dataset publication**. They are the preserved
evidence of what a provider or a person actually wrote.

Nine nullable columns are added beside them:

| column                              | meaning                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `province_code`                     | current province/municipality, official GSO code                            |
| `commune_code`                      | current ward/commune/special zone, official GSO code                        |
| `legacy_district_code`              | pre-2025-07-01 district — evidence, never current hierarchy                 |
| `administrative_mapping_status`     | `UNMAPPED \| AUTO_MATCHED \| NEEDS_REVIEW \| VERIFIED \| REJECTED \| STALE` |
| `administrative_mapping_source`     | which evidence produced the claim                                           |
| `administrative_mapping_confidence` | written **only** where computed deterministically; NULL otherwise           |
| `administrative_dataset_version`    | which dataset produced the codes                                            |
| `administrative_mapped_at`          | when                                                                        |
| `administrative_mapped_by`          | which admin, for a human decision                                           |

ADR-0016 is superseded **only** in its conclusion that codes must not be
stored. Its free-text compatibility decision remains valid and is reinforced
here. The premise that changed is narrow and factual: a code minted by an editor
resolves to nothing, but a code taken from the official statistical directory
resolves to a row GoGo can show, search and version.

**"Preserve free text" does not mean "never enrich".** Existing places are to be
populated with codes through the resolver, re-import or a controlled backfill.
What may not happen is the original text being overwritten.

### 2. `UNIQUE(code, effective_from)`, and a code alone is not an identity

This is not a precaution. Comparing the two pinned snapshots, **3,316 of the
3,321 current commune codes also exist in the historical set, and 2,212 of those
name a different unit**:

```
00004   Phường Trúc Bạch    ->  Phường Ba Đình
00008   Phường Liễu Giai    ->  Phường Ngọc Hà
00025   Phường Ngọc Khánh   ->  Phường Giảng Võ
```

A `UNIQUE(code)` would refuse 10,035 historical rows at import. The worse
failure is quieter: a stored `commune_code` read without knowing which dataset
produced it resolves to a _confidently wrong_ commune across the 2025-07-01
boundary. That is why `administrative_dataset_version` sits on `places` as a
required companion, enforced by a check constraint — and why the identity is
`(dataset_version, code, effective_from)`.

### 3. Datasets are staged, validated, reviewed, then published

`STAGED → VALIDATED → PUBLISHED`, with `REJECTED` and `ROLLED_BACK` terminal.
Import writes rows carrying their own `dataset_version_id`; it never touches the
active set. At most one version is `PUBLISHED`, held by a partial unique index —
the shape migration 0050 used for the CMS super-admin singleton, for the same
reason: the API is not the only writer.

Publication is one transaction that switches the active version, retains the
previous one, and writes an audit event. Rollback re-activates a previous valid
version: a forward act with its own audit row, not an undo. Republishing the
same version is refused, not silently ignored.

#### 3a. What publication is allowed to believe (ADM-005, #458)

The caller names a dataset and supplies nothing else — no `publishable` flag, no
checksum, no acknowledgement of the warnings. Inside the publishing transaction
the server re-reads the lifecycle status, the stored checksum, the checksum the
pinned files produce **now**, a digest of the staged rows, and the validation
result bound to all of them, and refuses on the first disagreement.

The digest — `snapshot_fingerprint`, stored inside `validation_report.boundTo` —
exists because the combined checksum cannot see a row edited directly in the
database: it is computed from the pinned files and the override revision, so a
`psql` session leaves it untouched while changing what the dataset holds. Without
the digest, "validated last week, then someone edited a staged row" would still
read as publishable.

`publishable === errors === 0`. An ERROR is never overridable. A WARNING never
blocks and stays visible and audited: the pinned dataset legitimately trips two,
and a publication path a warning could block would teach reviewers to silence
warnings rather than read them.

A version demoted by a later publication becomes `ROLLED_BACK` and keeps its
`published_at`; that pair — previously published, not active now — is what makes
it a legitimate rollback target, and it is why nothing is ever deleted. Rollback
deliberately does **not** re-verify the pinned files: a version published long
ago may have been built from a snapshot no longer vendored, and refusing on that
ground would remove the escape hatch exactly when it is needed. It verifies the
rows, which is what actually gets served.

Publish and rollback **report** stale place mappings; they write nothing to
`places`. Issue #458 originally had publication mark substantively-deactivated
mappings `STALE`. It does not, because whether a claim should be demoted depends
on facts publication does not have — above all whether a person verified it —
and a version switch must not be the thing that quietly overwrites that. The
write belongs to the mapping work (#459/#461/#462); the count and a bounded
sample are returned and audited so the decision is visible when it is taken.

The staff routes live under `/cms/administrative-datasets`, not under a new
`/admin` prefix: `AdminGuard` is bound there, the console already speaks it, and
a second staff prefix would split the surface. RBAC reuses the guard's existing
rule rather than inventing a permission — a write needs the exact `ops_admin`
role (or the audited super-admin bypass), a read needs only rank ≥ `ops_admin`.

### 4. The combined version is the identity of a published set

A GoGo dataset combines three independently pinned upstreams plus GoGo's own
reviewer overrides, so the published identity is the tuple:
`currentSourceVersion`, `historicalSourceVersion`, `mappingSourceCommit`,
`overrideRevision`, `combinedDatasetVersion`, `combinedChecksum`. Changing any
component — including a reviewer-approved override — mints a new combined
version that is validated, diffed and published like any other. **PostgreSQL is
authoritative for the active version.**

### 5. District is legacy-only, excluded by default

`unit_type` is `PROVINCE | MUNICIPALITY | WARD | COMMUNE | SPECIAL_ZONE |
LEGACY_DISTRICT`; `level` is `PROVINCE | COMMUNE | LEGACY_DISTRICT`. Legacy rows
carry `effective_to = 2025-06-30` and `status = 'INACTIVE'`, and every read
endpoint excludes them unless `includeLegacy=true`. Google may still return a
legacy district or locality component: it is kept and used **as evidence**,
never treated as the current legal hierarchy.

### 6. The advisory mapping is quarantined first, and an ambiguous split is never guessed

The change-mapping upstream is advisory. Rows are imported to
`administrative_mapping_quarantine` and classified; only structurally valid rows
whose source _and_ target resolve against the pinned snapshots are promoted to
canonical `administrative_unit_changes`. **A canonical row may never reference a
missing unit, and no current unit is ever fabricated to satisfy an advisory
target.**

Measured against the pinned trio:

| classification                   | rows                        |
| -------------------------------- | --------------------------- |
| `VALID_UNIQUE`                   | 132                         |
| `VALID_MERGE`                    | 9,432                       |
| `VALID_DISTRICT_TO_SPECIAL_ZONE` | 5                           |
| `DIVIDED_REQUIRES_REVIEW`        | **1,033**, from 471 sources |
| every other class                | 0                           |
| **canonical / quarantined**      | **9,569 / 1,033**           |

"Merged" means the successor absorbed more than one distinct legacy predecessor,
counting the ones that reached it through a split. Only **135** of the 3,321
current communes have a single predecessor at all — the 2025 reorganisation was
a consolidation, not a renaming, which is why the merge class dominates.

For a `SPLIT`: use verified coordinate boundaries where available, otherwise
return the candidates and require review. **Never decide by name similarity.**

Reviewer corrections create GoGo-owned override rows; the pinned upstream
snapshot is never edited, because it is the only remaining evidence of what the
source said. Precedence at resolve time:

1. GoGo reviewer-approved override
2. validated pinned upstream mapping
3. deterministic resolver evidence
4. unresolved review candidates

### 7. The resolver ranks evidence and refuses to choose arbitrarily

Priority: trusted official code → structured components → components validated
by coordinates → point-in-polygon on verified boundaries → exact normalized name
with a unique parent → historical aliases and validated change mappings → fuzzy
text, **as a CMS suggestion only**.

Invariants: never choose arbitrarily between candidates; fuzzy matching alone
can never yield `VERIFIED`; manual CMS confirmation yields `VERIFIED` plus an
audit event; provider address text is preserved on every path. Vietnamese
normalization reuses `normalizeVietnamese()` — one normalizer, not two.

**MVP approval policy:** approval requires a valid hierarchy and `VERIFIED`,
until measured resolver accuracy justifies relaxing it. `UNMAPPED`,
`NEEDS_REVIEW`, `REJECTED` and `STALE` block approval. Draft and import
ingestion may remain unresolved. Approval revalidates the mapping against the
_currently active_ version rather than trusting the stored value.

#### 7a. What the resolver may write, and what belongs to a person (ADM-006, #459)

`VERIFIED` and `REJECTED` are reviewer-owned. An unattended run may read them,
disagree with them, and report the disagreement — it may not act on it. The
place a fresh boundary release is most likely to contradict is exactly the place
someone already looked at _because_ the machine was wrong, and "the machine had
newer data" is not a reason to discard that. `REJECTED` has one documented way
back, an explicit rematch action; `VERIFIED` has none.

`NEEDS_REVIEW` and `STALE` are queue states rather than decisions, so a later run
that finds decisive evidence may resolve them.

`updated_at` does not move when nothing material changed — a nightly pass over
an unchanged catalogue must not look like a catalogue that changed every night.

**Reviewer attribution follows the decision, not the row.**
`administrative_mapped_by` names who is responsible for the mapping the row
carries _now_; the history of everyone who ever touched it is the audit log,
which keeps all of them. So:

| situation                                                                                 | mapping                 | `administrative_mapped_by` |
| ----------------------------------------------------------------------------------------- | ----------------------- | -------------------------- |
| ordinary automatic run against `VERIFIED`                                                 | no write                | unchanged                  |
| ordinary automatic run against `REJECTED`                                                 | no write                | unchanged                  |
| authorised rematch of `REJECTED` → `AUTO_MATCHED` / `NEEDS_REVIEW` / `UNMAPPED` / `STALE` | replaced per the matrix | **cleared**                |
| rematch that leaves `REJECTED` standing                                                   | no write                | unchanged                  |
| no-op on a reviewer-owned row                                                             | no write                | unchanged                  |
| manual verification (#462)                                                                | `VERIFIED`              | set to the reviewer        |

The rematch actor is recorded in the audit event under its own key and is never
written to the column: asking for a rematch is not verifying anything, and a
machine-produced mapping that still carried a reviewer's id would read as
reviewed to anything keying on that column being set.

**Confidence is definitional or absent.** Deterministic _selection_ and
calibrated _certainty_ are different claims, and conflating them puts a number
nobody measured in front of decisions downstream. `1.00` is written only where
the evidence answers "which unit is this" by construction and nothing
contradicts it:

| evidence                                                                               | confidence |
| -------------------------------------------------------------------------------------- | ---------- |
| explicit official codes validated against this exact dataset version                   | `1.00`     |
| unique, strictly-inside point-in-polygon containment with a valid implied province     | `1.00`     |
| exact normalized name, with or without a city narrowing it                             | NULL       |
| canonical historical change mapping, including district → special zone                 | NULL       |
| a unique containment that sits on an edge                                              | NULL       |
| province-only, divided/split without independent unique geometry, any fuzzy suggestion | NULL       |
| any result with contradicting deterministic evidence                                   | NULL       |

A result is still `AUTO_MATCHED` with a NULL confidence; its certainty is
carried by `method`, `evidence`, `status` and `datasetVersion` — four things a
reviewer can check — rather than by one number that cannot be checked. A
contradiction voids the number even where the contradicting claim was itself
invalid and never reached the answer.

Staleness is **evaluated, never written**. The distinction that matters is
between a mapping _labelled_ with an older dataset version — the normal state of
the catalogue between publications — and one the new dataset _invalidates_. Only
the codes tell those apart, so the stored version alone is never the test, and
the verdict carries no proposed status: what to do about a stale `VERIFIED`
place belongs to #461/#462 and to a person.

Boundary polygons live in `administrative_unit_boundaries`, created empty by
migration 0052 and filled by ADM-007 (#460), which pins the release and verifies
its checksum. Containment uses `ST_Intersects`, not `ST_Contains`: a point on a
shared border is inside Vietnam and inside two communes, and reporting that as
ambiguous is correct where reporting it as "no match" would be a lie about the
geometry. A shared edge is reported apart from genuinely overlapping polygons
because the two have different fixes. There are no legacy district polygons at
any release — the units were dissolved before any of them were drawn — and a
CHECK constraint says so, so a legacy code can never be boundary-derived.

#### 7b. The boundary release: pinned by commit, verified by checksum (ADM-007, #460)

The GeoJSON release is 47.6 MB compressed and 629 MB expanded, so it is the one
pinned input GoGo does not vendor. The pin moves from the bytes to an immutable
commit URL plus a SHA-256 verified before a single entry is read — integrity is
preserved, only availability is traded, and availability is not on the request
path: nothing fetches it at startup, and the resolver reads polygons out of
PostgreSQL. A 64 KB fixture of five real entries is committed so every test runs
offline against genuine geometry.

Boundaries ship at **v5.0.0, the same tag as the current units**, and the two
agree exactly: 34/34 provinces, 3,321/3,321 communes, zero parent
disagreements. §10's cross-release hierarchy check stays, because agreement
measured once is not agreement guaranteed.

**Nothing is repaired.** `ST_Multi` is the only normalization and it promoted
nothing — every one of the 3,355 features is already a MultiPolygon in WGS84
with 2D coordinates. `ST_MakeValid` is not used anywhere: an invalid polygon is
an ERROR that names the unit, because repairing one silently would move a border
and nobody would know which.

ERROR is a structural impossibility — geometry PostGIS cannot use, a code no
unit holds, a hierarchy the units contradict, a duplicate identity, a count that
is not the count that was pinned. WARNING is coherent geography. The pinned
release loads with **three warnings and no errors**: 233 same-level overlaps,
1,370 communes not fully covered by their own province polygon, and 56 area
outliers. The middle figure is 41% of the country and is not a defect — province
and commune outlines were simplified independently — and it changes nothing,
because the resolver takes a commune's province from the **units** table and
never from a province polygon.

#### 7c. Bulk enrichment is a pinned, resumable, dry-run-by-default job (ADM-008, #461)

The backfill reimplements none of §7a: it calls the same `resolvePlace` and
`persist` a single-place call uses, so a place enriched in bulk gets the same
answer, the same transition matrix and the same reviewer protections as one
enriched on its own.

**Dry run is the default**, everywhere. A dry run executes the real selection
and the real resolver and reports exactly what it would have written — that is
what makes it evidence about the execute rather than a rehearsal of a different
program, and the invariant is asserted: the two runs produce identical resolver
counts.

**Batches commit separately.** One transaction across a catalogue would hold
locks for its whole duration and throw away 90% of the work on a failure at
90%. Each place is its own write; each batch checkpoints a cursor; a resume
continues strictly after the last committed id.

**A run is pinned** to the dataset and boundary versions it started against,
re-checked before every batch. If the active version moves the run stops with
its cursor intact rather than writing half the catalogue against one release and
half against another — the failure that would be invisible afterwards, because
every individual row would look correct.

**Selection is a policy, not a scan of everything.** Both reviewer-owned states
are excluded in SQL and never reach the resolver, and a place already resolved
against these exact versions is not selected at all — so a second run over
settled data selects nothing rather than walking the catalogue to discover it
has no work.

**`REJECTED` cannot be reopened from this job at all.** §7a gives the resolver an
authorised rematch, and a bulk command has nobody to attribute one to: every
CLI-originated audit row in this repository is written as `actorType: 'system'`
with a null actor id, because no command authenticates anybody. A switch that
reopened reviewers' rejections while recording "system" as who asked would be
worse than no switch, so the job has none. Rematch belongs to #462's
authenticated workflow, where there is a real reviewer to name.

**A run writes only while its pinned versions are the active ones.** The check
runs before every batch, including the first batch of a resume, and it asks
which version the published dataset points at — not whether the old snapshots
happen to still be in the database. They always are: boundary rows are never
deleted, and treating their presence as authorisation would stamp places with a
version nothing serves any more. A run that stops this way keeps its cursor and
counters, and a repeated resume stops again without writing. The only recovery
that continues it is a rollback restoring both exact versions; otherwise the run
is closed as `abandoned` — a terminal state, so a run that will not finish never
reads as one that might — and the work goes into a new run pinned to what is
active now. Pins are written once and never updated.

Audit is one row per run plus one per material place write, each citing the run
id. A no-op writes nothing: a nightly pass over an unchanged catalogue must not
fill the audit log with news of nothing happening.

One consequence worth recording, found by the dry-run/execute equality test: an
`UNMAPPED` result claims nothing, so it stamps no dataset version, and a place
that is already `UNMAPPED` is therefore _unchanged_ by it. Comparing against the
dataset version regardless made the resolver report a change the write path then
correctly declined to make.

### 8. The cache is in-process, version-keyed, behind a port. Redis is not used.

The published set is ~800 KB and immutable within a version; publication is
rare; Upstash bills per command; nothing here needs shared mutable state. So:
per-process immutable indexes built once per activated version — units by code,
provinces, communes by province, normalized-name candidates, aliases, change
mappings — never the full dataset per request.

Concurrent loads are deduplicated. A cache entry is published only after a
complete successful load; a failed load leaves the previous valid entry serving.
Only the active and optionally the previous version are retained, so memory is
bounded.

The **active-version pointer** lives in process memory and is revalidated
against PostgreSQL on a bounded TTL (default 60s), not per request. The
publishing process switches immediately after commit; others switch within the
TTL. Every administrative response and every mapping result carries
`datasetVersion`.

No Redis Pub/Sub, no Redis locks, no wildcard scans, no administrative Redis
keys. Incremental Upstash commands: **zero**.

### 9. Mobile is deferred, deliberately

GoGo-MobileApp has no address-entry screen, no screen that renders or selects a
commune, and `place-import` is add-by-link only. There is no consumer. Shipping
query hooks, version polling, offline snapshots or a picker would be a dead
integration, which `.claude/rules/core.md` #16 forbids. **DEFERRED — NO CURRENT
CONSUMER**, recorded as GoGo-MobileApp#148 with a future integration plan and no
code. The flow stays: mobile submits a Google link → BE fetches Details → the BE
resolver maps codes → CMS reviews ambiguity → approval enforces the policy.

### 10. Boundary-derived codes are GoGo facts; Google address content stays out

The Google-content freeze is permanent — `GoGo-BE/CLAUDE.md` and
`GOGO_PRODUCT_DATA_ARCHITECTURE.md` limit Google to identity, routes and
directions, and PR8 was cancelled rather than deferred. GoGo consequently stores
no Google address component: none on `place_provider_sources`,
`place_sources.raw` stopped and nulled by migration `0033`, and no
`PLACE_FIELD_MASKS` tier asking for `addressComponents`.

That freeze left one question open, and the repository owner answered it on
2026-09-07 (GoGo-BE#464). The two halves land differently, and the boundary
between them is **purpose**, not mechanism.

**Allowed — administrative codes derived from stored geometry.** Intersecting an
already-stored `places.geom` with GoGo's pinned MIT boundary dataset to write
`province_code` and `commune_code` is a **GoGo-generated normalized fact**, not a
provider-derived column. `places.geom` is already accepted GoGo data; no Google
request is made; the classification runs entirely against GoGo-controlled MIT
data; and the result is reproducible from the stored geometry plus a pinned
boundary version. Provenance is recorded explicitly and always:
`administrative_mapping_source = 'boundary_point_in_polygon'`,
`administrative_dataset_version`, `administrative_boundary_version`,
`administrative_mapped_at`, and the resolver status.

**Prohibited — fetching Google address content for this purpose.**
`addressComponents` is not added to any field mask, and Place Details is not
called to obtain administrative components for ingestion or for backfill.
Calling Details for components and persisting only a derived code is still use
of Google content **for an administrative-address purpose**, and that purpose is
outside the three permitted uses. "Same-execution reuse" authorises reuse within
a purpose already permitted; it does not authorise a new one, and it does not
make persisted derived output compliant. Nothing in this ADR supersedes or
weakens the permanent Google-content architecture.

So Google administrative components appear at **no level** of the resolver
precedence, which is:

1. GoGo reviewer-approved override
2. trusted, explicitly supplied official codes
3. unique boundary intersection against the pinned current dataset
4. validated historical mapping / name evidence
5. unresolved candidates for CMS review

**Point-in-polygon rules.** SRID 4326 throughout; geometry validated before
intersection; MultiPolygon handled; deterministic behaviour defined for a point
lying on a shared edge; zero matches and multiple matches both detected, and a
multiple match is **never** resolved by picking one. The commune→province
hierarchy is validated against the same dataset version, which is recorded, so
the same point and version always give the same answer.

| outcome                       | status                                                 |
| ----------------------------- | ------------------------------------------------------ |
| unique commune and province   | `AUTO_MATCHED`, evidence `boundary_point_in_polygon`   |
| province unique, no commune   | `NEEDS_REVIEW`                                         |
| several communes or provinces | `NEEDS_REVIEW`, candidates listed                      |
| no containing polygon         | `UNMAPPED` or `NEEDS_REVIEW`, per the documented cause |
| geometry invalid or missing   | `UNMAPPED`                                             |
| reviewer confirmation         | `VERIFIED`                                             |

**`legacy_district_code` gets no boundary path at all.** The chosen boundary
source has no legacy district polygons, so point-in-polygon cannot resolve one
and must not pretend to. It may be populated only from a uniquely resolved
historical name or code already lawfully stored, a validated historical mapping,
explicit import data whose licence permits persistence, or a CMS reviewer's
selection. Otherwise it stays `NULL` and the evidence is marked unavailable.
Legacy boundary support is not fabricated.

**Approval is unchanged by this.** A boundary-derived `AUTO_MATCHED` populates
the codes; it does not approve a place. CMS verification remains required for
MVP approval until a separately accepted policy says otherwise, and the reviewer
sees the matched province and commune, the point in map context where supported,
the boundary dataset version, the match method, any conflict or rival candidates,
and the legacy-district status.

## Sources, pinned

| role                    | repo                                        | ref                                                   | file                                                | licence |
| ----------------------- | ------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- | ------- |
| current units           | `thanglequoc/vietnamese-provinces-database` | `v5.0.0` @ `b092d6b45ea76c39990afd34375eabe1f6c3a492` | `json/simplified_json_generated_data_vn_units.json` | MIT     |
| historical units        | same repo                                   | `v2.4.1` @ `fc33b7411ec4e3697817fab8118718a8d39ef090` | same path                                           | MIT     |
| advisory change mapping | `tranngocminhhieu/vietnamadminunits`        | `7fac8c45805aad9916b17237c54baf4502303b93`            | `data/interim/convert_legacy_2025_simple.csv`       | MIT     |

```text
b2af4329be6bbbb68bb53217d26edc8d4ff0a24aea5ad5569e72232cf6275ac3  v5.0.0 units
86c1e097b1b8b63cf5f8b7aa71d90e3bd97f2e75412af67d5dede4d9c0e91899  v2.4.1 units
93d53e6f53d2094a0bfa4a17fba18f772eab36106737962b00fe1749ca7bbb1d  7fac8c4 mapping
```

Verified by fetching and counting, not assumed:

- **v5.0.0**: 34 provinces (7 municipalities, 27 provinces), 3,321 communes (697
  phường, 2,610 xã, 13 đặc khu), no duplicate codes, current to Decree
  30/2026/QH16, released 2026-08-31. **This source alone decides whether a
  current target code exists.**
- **v2.4.1**: 63 provinces, 696 districts, 10,035 communes, no duplicate codes
  at any level. Imported as inactive, effective-dated history.
- **mapping**: 10,602 rows; every one of the 10,035 historical communes has an
  outbound row and every one of the 3,321 current communes an inbound row —
  coverage is complete against these pins. Advisory nonetheless, and never
  authoritative current data.

Known source defects, carried as warnings rather than fixed silently: commune
`06325` is `"xã Bắc Sơn"` with a lowercase type prefix, so unit type is derived
case-insensitively; five rows carry a district-level source (island districts
that became đặc khu — Bạch Long Vĩ, Cồn Cỏ, Hoàng Sa, Lý Sơn, Côn Đảo, two of
them changing province), classified `VALID_DISTRICT_TO_SPECIAL_ZONE` rather than
discarded as malformed.

Boundaries (ADM-007, #460): `json/vn_provinces_wards_geojson.zip` at **v5.0.0,
the same immutable commit as the current units** — 34/34 provinces and
3,321/3,321 communes as MultiPolygons in **SRID 4326**, the same SRID as
`places.geom`, derived from the Vietnam Administrative Units Reference Map
(sapnhap.bando.com.vn).

An earlier reading of this ADR selected the **v4.0.0 (2026-06-20)** GIS release,
because that was the newest tag carrying GIS data when #460 was written. It is
no longer the selected source: v5.0.0 ships a purpose-built provinces-and-wards
archive, and taking boundaries from the same commit as the units removes an
entire class of disagreement rather than managing it.

The separate pinning and the cross-source consistency gate **stay**. The two
components are still versioned independently in the combined dataset version,
and the loader still refuses a release whose commune parents disagree with the
units — measured agreement today is not guaranteed agreement at the next
release, and the gate is what will catch the day they diverge.

There are **no legacy district boundaries** at any release, so point-in-polygon
can never resolve `legacy_district_code`.

## Consequences

- The place contract gains optional fields only. Nothing is removed or retyped,
  so the `oasdiff` breaking-change gate stays green.
- `UNMAPPED` is the value on every existing place until enrichment runs. The CMS
  must say so in words, not render a blank.
- An ETag appears on the administrative read endpoints — the first in this API,
  scoped to them, because this is the first genuinely immutable-per-version
  resource GoGo serves.
- `administrative.ts` references admin ids as plain `uuid` at the drizzle level;
  the foreign keys are real and live in the SQL migration. This avoids the
  import cycle `places → administrative → cms → places`, which would leave the
  enums uninitialised when `places.ts` evaluates them.
- 1,033 quarantined rows across 471 split sources are the initial manual review
  backlog. Unresolved advisory rows do not block publication while they stay
  quarantined and their counts are reviewed explicitly.
- The importer runs offline from checked-in, checksummed snapshots. **No GoGo
  runtime process ever calls a public administrative API.**

## Migration & rollback

`migrations/0051_administrative-units.sql` is additive only: five tables, nine
nullable columns on `places`, nine enums, two check constraints, no drops, no
type changes, no value rewritten. `places.city`, `places.district`,
`places.address_text` and `places.area_key` are untouched in both directions.
The `Down:` block at the head of the migration removes exactly what it added.

Deploying it ahead of the API is a no-op for the running code, which is what
lets the database ship before the endpoints.
