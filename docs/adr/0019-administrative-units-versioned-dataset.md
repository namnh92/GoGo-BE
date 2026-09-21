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
Only the first two are validatable — see §3a-i.
Import writes rows carrying their own `dataset_version_id`; it never touches the
active set. At most one version is `PUBLISHED`, held by a partial unique index —
the shape migration 0050 used for the CMS super-admin singleton, for the same
reason: the API is not the only writer.

Publication is one transaction that switches the active version, retains the
previous one, and writes an audit event. Rollback re-activates a previous valid
version: a forward act with its own audit row, not an undo. Republishing the
same version is refused, not silently ignored.

#### 3a-0. Reviewer adjudication of the advisory source (ADM-011, #484)

1,033 rows of the pinned change-mapping upstream are quarantined, every one a
commune the source says was divided, across 471 sources. The source offers a
default successor for each; §2 forbids trusting it, because which successor a
divided commune became is a question about where a place physically is. So a
person decides — and until #484 there was nowhere for that decision to go. The
`reviewer_decision` columns on `administrative_mapping_quarantine` were declared
in 0051 and never read or written by anything.

The shape is append-only draft, then explicit materialisation:

1. decisions are rows in a **draft override set** bound to one immutable base;
2. a decision has **no runtime effect at all**;
3. an explicit **materialisation** produces one new immutable STAGED dataset;
4. that dataset goes through the ordinary validate → diff → publish path;
5. only publication changes what the resolver answers.

**Why a draft rather than a dataset per decision.** A dataset version owns its
rows — 14,149 units, 9,571 changes and 1,033 quarantine rows on the pinned
source — because that is what makes the snapshot fingerprint mean anything.
Minting one per click would be 24,700 rows per reviewer decision and 1,033
versions per review round. One clone per round costs 593 ms, measured.

**Why the resolver needed no change.** It consults quarantine only when no
canonical edge exists for a source code, and it filters edges to
`resolution = 'resolved'`. A draft decision creates no edge, so a draft ACCEPT
cannot outrank published data _by construction_ rather than by a rule anybody
has to remember; a materialised ACCEPT creates exactly the edge the resolver
already knows how to use; a REJECT creates none, so the code stays unresolved,
which is what a rejection means.

**One draft per base dataset**, held by a partial unique index. The combined
checksum is a pure function of the four pinned source checksums plus
`override_revision`, and both the version string and the checksum are unique —
two drafts on one base would both mint `r+1` and the second would be refused
after copying 24,700 rows. The next round opens against the _derived_ dataset:
r0 → r1 → r2. A base that already materialised refuses to open a second draft
(`OVERRIDE_BASE_ALREADY_MATERIALIZED`) rather than letting a reviewer build a
round that could never land.

**Nothing is ever edited.** Not the pinned snapshot, not the base dataset's
rows — a materialisation leaves them byte-identical, which is asserted — and not
an earlier decision. A correction appends a decision that supersedes the
previous one. The single column ever updated is the back-pointer
`superseded_by_id`, written by the replacement inside its own transaction so
that "one effective decision per row" is a database constraint; its foreign key
is `DEFERRABLE INITIALLY DEFERRED`, because the pointer has to be written before
the row it points at exists.

**Concurrency is a revision, not a lock.** Every mutation sends the draft
revision the reviewer was looking at. Two people deciding the same row a second
apart both succeed without it and the second silently wins, which is the one
failure a review queue cannot have. Materialisation additionally takes the same
advisory transition key as publish, rollback and validate.

**Two validation gates learned about overrides.** `MERGE_SPLIT_STRUCTURE` says a
SPLIT is never canonical — true of the _upstream_, and false of a SPLIT a
reviewer decided, which carries the id of the decision that made it.
`QUARANTINE_EXCLUDED` refuses a row that is both quarantined and canonical —
except through an override, because the quarantine row is retained on purpose as
the evidence of what the source said before anybody adjudicated it. Three gates
were added: `OVERRIDE_PROVENANCE`, `OVERRIDE_CONFLICT` (one source cannot carry
overrides onto two successors) and `OVERRIDE_REVISION_CONSISTENT`.

The diff gained `OVERRIDE_ACCEPTED` and `OVERRIDE_TARGET_CHANGED`. A
materialisation of two decisions diffs as two entries plus one `SOURCE_DRIFT`
for the revision — not as 9,569 replayed migrations, because the diff already
skips edges the baseline asserted. `OVERRIDE_REJECTED` is deliberately absent: a
rejection creates no edge, so it changes the derived dataset's provenance rather
than its content, and it is reported in the decision counts instead.

**A decision is taken on a row; the fact is about the source (#622, 2026-09-21).**
The 1,033 quarantined rows describe 471 sources, so a divided commune usually
carries two or three advisory rows — and the resolver answers one successor per
source. Two rows of one source accepted onto different targets, in one draft or
across rounds, produced a version that `OVERRIDE_CONFLICT` refused forever (DEV
r2 and r3, 2026-09-17: `00007 → 00025` in r1, then `00007 → 00008` accepted on
the sibling row). Three things follow:

1. Accepting a row is refused when the base already carries a reviewer
   override for its source onto another target
   (`OVERRIDE_SOURCE_ALREADY_RESOLVED`, naming the target and the round), or
   when the draft already accepts a sibling row
   (`OVERRIDE_SOURCE_CONFLICT_IN_DRAFT` for another target,
   `OVERRIDE_SOURCE_ALREADY_DECIDED_IN_DRAFT` for the same one). The gate stays
   as the last line; the decision path no longer reaches it.
2. The other rows of a settled source read `SOURCE_SETTLED` — not actionable,
   not in the backlog — and the detail names the target and the round that
   settled them.
3. Materialisation carries the stamp of earlier rounds (`coalesce` with the
   base row's `reviewer_decision`), because a decision taken in r1 is still
   taken on r2. The read layer treats the override _edge_ as the fact and the
   stamp as its copy, so a version minted before this reads correctly as well.

Changing where a settled source goes is a retraction of the earlier override
(ADM-028, #623), never a second accept.

**Retracting a materialised override (#623).** A REJECT taken, in a later
round, on the row a base override was decided on retracts that override: the
materialisation does not carry its edge, the source is unresolved again, and
the diff against the published version reports `OVERRIDE_RETRACTED`. A REJECT
on a sibling row retracts nothing — that row never produced an edge. Nothing is
edited: the earlier decision, its edge on the earlier version and the quarantine
row all stay; the derived version simply does not repeat the edge. Re-pointing a
source is therefore two rounds — retract, then accept — never a second accept.

#### 3a-i. Validation is a transition, not a read (#482)

`validate` runs the gates and stores the report — and, with it, the resulting
lifecycle status: `publishable ? VALIDATED : STAGED`. That is the right answer
for a version being prepared and a demotion for every other version there is.
Applied to the active dataset it moved it out of `PUBLISHED`, and the partial
unique index does not save that case: it forbids _two_ active versions, not
_zero_. The environment was then left with no active dataset, `capability`
reported `MISSING`/`BLOCKED`, and the approval guard refused every place until
somebody published again. Applied to a `ROLLED_BACK` version it took it out of
the restorable set, because `rollbackRefusal` requires exactly that status.

So the state machine is closed:

| from          | gates    | to                                       |
| ------------- | -------- | ---------------------------------------- |
| `STAGED`      | no ERROR | `VALIDATED`                              |
| `STAGED`      | ERROR    | `STAGED`                                 |
| `VALIDATED`   | no ERROR | `VALIDATED`                              |
| `VALIDATED`   | ERROR    | `STAGED`                                 |
| `PUBLISHED`   | —        | refused, `DATASET_STATE_NOT_VALIDATABLE` |
| `ROLLED_BACK` | —        | refused, `DATASET_STATE_NOT_VALIDATABLE` |
| `REJECTED`    | —        | refused, `DATASET_STATE_NOT_VALIDATABLE` |

Because it writes a lifecycle status, validation takes the same advisory
transition key as publish and rollback and queues behind them rather than
interleaving. The row is re-read `FOR UPDATE` inside the writing transaction and
the identity the report was computed from — status, combined version, combined
checksum, override revision, and the digest of the staged rows, sampled before
the reads and again under the lock — must still hold. A publication that won the
lock, an override bump, or a direct edit to a staged row during the run makes the
report evidence about rows that are no longer there, so it is discarded with
`DATASET_CHANGED_DURING_VALIDATION`.

A refused run writes nothing: not the status, not the previous validation, not
the active pointer, not the restorable set, not a place, not the cache. The one
thing it does write is the audit row for the refusal, as
`administrative_dataset.validate_rejected` — never as `validate`, which would
claim a report exists that does not.

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

**MVP approval policy (implemented in ADM-009, #462):** approval requires
`VERIFIED` and a hierarchy that still holds. `UNMAPPED`, **`AUTO_MATCHED`**,
`NEEDS_REVIEW`, `REJECTED` and `STALE` all block it — `AUTO_MATCHED` included,
because it is the resolver's answer and the whole point of a review queue is
that the machine's answer is not the decision. Draft and import ingestion may
remain unresolved.

Approval revalidates against the _currently active_ dataset rather than
trusting the stored value — but on **identity**, not on the version string. Every
publication mints a new combined version; requiring the stamp to match would
un-approve the whole catalogue on every release and demand it be re-verified by
hand, which is not a stricter policy but an unusable one. So the gate asks
whether the commune still exists, is still current, and still sits under the
mapped province. The version the reviewer worked against is kept as provenance
and reported in the remediation view.

The gate lives inside `transitionPlace`'s transaction, which is now one
transaction for the first time: the place is locked, the mapping and the active
dataset are re-read, and the commune is re-resolved, all before the status
flips. A policy checked before the transaction is one a concurrent publication,
a mapping rejection or another reviewer can invalidate in between.

**The invariant governs every path, not one endpoint.** It lives in one shared
guard — `evaluatePlaceApproval` / `assertPlaceApprovable` — and every write that
can make a place `published` calls it inside the transaction that performs the
transition:

| path                                  | how                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `transitionPlace` (CMS status change) | `assertPlaceApprovable` before the update                                   |
| CMS bulk import (`publish_approved`)  | `settlePublication` → `evaluatePlaceApproval`                               |
| link import (`autoPublish`)           | `evaluatePlaceApproval` before promoting the new row                        |
| `libs/database/src/seed.ts`           | development fixture, builds a database directly, never a product write path |

A unit test asserts that set: the files able to write a `place_status` are
enumerated, and a new one fails the build until somebody decides which list it
belongs in. The policy itself is defined once — a second copy would drift, and
the reason this section exists is that the bulk import had already published
places for months without consulting it.

**Bulk ingestion stays; bulk _publication_ becomes conditional.** A place the
import creates has never been verified by anybody, so its publication is
deferred and the place lands in `review` — in front of a reviewer, because the
operator did ask for it to go live — rather than in a drawer. The row records
why (`deferred_mapping_unverified`, `deferred_mapping_invalid`,
`deferred_no_active_dataset`), the job result reports `requested`, `published`
and `deferred` separately from `rowsByStatus`, and a deferral is never counted
as a failure: it is a successful import of a place that is not yet live. The one
bulk row that can publish is one matching an **existing** place whose mapping a
reviewer already verified and which is still valid against the active dataset.

**An environment cannot publish any place until an administrative dataset is
published there** — there is nothing to validate a mapping against otherwise,
and the guard says so with `ADMINISTRATIVE_DATASET_UNAVAILABLE` rather than
letting the place through.

#### 7b. Amendment (ADM-015, #495): canonical codes come from codes and geometry only

The precedence in §7 listed "exact normalized name with a unique parent" and
"historical aliases" as resolvable evidence, and ADM-006 implemented both by
reading `places.city` and `places.district`. Both are removed.

**What changed.** The resolver now has exactly three evidence providers:
trusted codes, point-in-polygon against the pinned boundaries, and the canonical
change mapping applied to a commune **code** the place already carries. It is
not given `city` or `district` at all — the input type has no field for them.

**Why.** `district` names a tier dissolved on 2025-07-01. A commune selected
because somebody typed "ba dinh" is a commune selected out of a hierarchy that
no longer exists, and the code it produces is indistinguishable, everywhere
downstream, from one the geometry actually supports. `city` is worse in a
subtler way: on the bulk-import path it is a **provider search hint** — the
string an operator wrote to help Google find the place — and treating it as a
claim about which province the place is in gives a wrong answer a confident
`AUTO_MATCHED`. §5 already said district is legacy-only and excluded by default;
this closes the one place that still read it.

**What did not change.** The columns stay (ADR-0016), are still stored, still
returned, and are still what a place's address reads as. `legacy_district_code`
is still writable — by an explicit `trustedCodes.legacyDistrictCode`, which is
somebody asserting a code, not a name being turned into one. The transition
matrix, the approval policy and the "never choose arbitrarily" rule are
untouched.

**Consequence.** Rows whose only signal was free text resolve `UNMAPPED` rather
than `AUTO_MATCHED`. That is the intended outcome: `UNMAPPED` blocks
publication and puts the place in front of somebody, where a name-derived code
would have passed silently. The `exact_name` and `structured_components` methods
remain in the enum because stored rows carry them; nothing writes them any more.

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

Boundaries ship at **v5.1.0, the same tag as the current units** (v5.0.0 until
the 2026-09-16 re-pin, #610), and the two agree exactly: 34/34 provinces,
3,321/3,321 communes, zero parent disagreements. §10's cross-release hierarchy check stays, because agreement
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

#### 7d. Moderation: who may write what (ADM-009, #462)

`VERIFIED` has exactly one writer — a moderator, through the moderation API.
The resolver may not write it, the backfill may not write it, and neither may
an editor: the person who decides a place belongs in the catalogue is not the
person who certifies where it is. `super_admin` bypasses both, audibly.

| action                                      | role                                 |
| ------------------------------------------- | ------------------------------------ |
| read the queue, read one mapping's evidence | rank ≥ `moderator` (so `editor` too) |
| verify · reject · correct · rematch         | exact `moderator`                    |
| reconcile against the active dataset        | exact `ops_admin`                    |
| approve the place                           | exact `editor`, as it already was    |

Every decision re-reads its row `FOR UPDATE`, re-reads the active dataset,
re-checks the hierarchy and requires `expectedUpdatedAt` — a reviewer's screen
is a photograph, and between the photograph and the click a dataset can publish
and another reviewer can decide.

**Attribution follows the decision.** Verification sets
`administrative_mapped_by`; a rematch clears it, because the requester has not
verified anything and the audit says so; and a `STALE` row **keeps** it, because
that person did verify the stored mapping — `STALE` says the verification is no
longer current, not that it never happened. The reconciler is named separately
in the audit so the log can never be read as "this person verified it".

No confidence number is written by a manual verification. A person's judgement
is not a probability; `VERIFIED` plus their identity is the whole claim.

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
| current units           | `thanglequoc/vietnamese-provinces-database` | `v5.1.0` @ `f8de63cd778b2f6144d7e7c0153cd5c711f58c60` | `json/simplified_json_generated_data_vn_units.json` | MIT     |
| historical units        | same repo                                   | `v2.4.1` @ `fc33b7411ec4e3697817fab8118718a8d39ef090` | same path                                           | MIT     |
| advisory change mapping | `tranngocminhhieu/vietnamadminunits`        | `7fac8c45805aad9916b17237c54baf4502303b93`            | `data/interim/convert_legacy_2025_simple.csv`       | MIT     |

```text
17bf75142931d143174883328edd02850526b16531ee434b4cc524386e7e5e28  v5.1.0 units
86c1e097b1b8b63cf5f8b7aa71d90e3bd97f2e75412af67d5dede4d9c0e91899  v2.4.1 units
93d53e6f53d2094a0bfa4a17fba18f772eab36106737962b00fe1749ca7bbb1d  7fac8c4 mapping
```

Verified by fetching and counting, not assumed:

- **v5.1.0**: 34 provinces (8 municipalities, 26 provinces), 3,321 communes (697
  phường, 2,610 xã, 13 đặc khu), no duplicate codes, current to Nghị quyết
  36/2026/QH16, released 2026-09-13. **This source alone decides whether a
  current target code exists.** Re-pinned from v5.0.0 on 2026-09-16 (#610): the
  measured delta is one row — province `22` becomes `Thành phố Quảng Ninh`, which
  is why the municipality count moves 7 → 8 — and no commune code, parent or name
  changes, so no place mapping is invalidated by the move.
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

Boundaries (ADM-007, #460): `json/vn_provinces_wards_geojson.zip` at **v5.1.0,
the same immutable commit as the current units** — 34/34 provinces and
3,321/3,321 communes as MultiPolygons in **SRID 4326**, the same SRID as
`places.geom`, derived from the Vietnam Administrative Units Reference Map
(sapnhap.bando.com.vn).

An earlier reading of this ADR selected the **v4.0.0 (2026-06-20)** GIS release,
because that was the newest tag carrying GIS data when #460 was written. It is
no longer the selected source: from v5.0.0 onwards the upstream ships a
purpose-built provinces-and-wards archive, and taking boundaries from the same
commit as the units removes an entire class of disagreement rather than managing
it. That rule is what moved both pins together to v5.1.0 in #610 — the units
release is the one that changed, and the boundary archive follows its commit.

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
