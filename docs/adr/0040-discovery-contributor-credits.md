# ADR-0040: Discovery totals, venue verification, contributor credits and Home

Date: 2026-11-06. Status: accepted for GoGo-BE#774 (owner scope and Astra advice).

Search totals are exact and opt-in, before cursor/limit, in the page statement's
snapshot. Eligibility includes the same latest per-person price row, synonyms,
rating, lodging and effective location. Counted searches have configurable
whole-statement timeout, per-IP rate and per-process concurrency bounds. A timeout
or concurrency refusal returns retryable SEARCH_COUNT_UNAVAILABLE; clients retry
without totals. No cache, estimates, facets or separate count endpoint. No corpus
performance claim is made without CI/deployment EXPLAIN and load evidence.

Taxonomy dimensions intersect; category/mood/setting/suitability are OR, amenities,
dietary/accessibility are ALL. cashless_payment is a query expansion to card OR QR,
never a separate venue association. Unknown facts do not satisfy filters.

GoGo verified means identity and location independently checked by a CMS moderator
(or super admin), using an approved site visit, official registry or venue document
establishing both identity and location, with an internal reference. It does not
certify quality, safety or every fact. Decisions require an identity/verification
ETag and idempotency key. Equivalent evidence preserves the timestamp. Name,
address or geometry changes conservatively count as material: a database trigger
increments identity revision, revokes the badge and audits that revocation in the
same transaction. Public responses contain no evidence or actor.

Prospective approvals grant the original registered submitter 50 no-expiry credits.
No guest-claim, historical or merged reward. Preparation runs outside transactions;
submission revision, pending state and canonical identity are rechecked under lock.
Draft, source, decision, unique award, audit and outbox commit together. Source IDs
remain immutable for deduplication after erasure. Balance increases only for a new
grant. Existing admission/moderation controls remain; no new cap, debt or clawback.

One accepted user send uses daily allowance first, then one credit; subsequent
provider failure remains charged, replay/rejection costs zero. Credits never bypass
burst, readiness, kill switch, global budget or BYOK quarantine. Grants, sends and
erasure share the exact account advisory lock. Send lock order is account → global
budget, then resolve one acceptance time for quota, month budget and usage. Approval
uses account (registered submitter) → submission → canonical venue identity → user
row; erasure uses account → user row → owned submissions. Account serialization
prevents approval/erasure inversion; guest approvals have no account or user-row
locks. No provider call under a DB lock.
Credit audit survives usage-ledger retention; erasure drops the balance and nulls
user linkage, retaining immutable source IDs. Export includes the own balance.

Home is a membership-scoped top-one temporal selection before limit, with null
nextCursor and no cursor/status overrides. Active rooms with no expired explicit
end lead, ordered by absolute start proximity (unknown last, future active starts
allowed), then future collecting/matching/ready by earliest start, UUID descending
for ties. Reads never mutate room status.

Contract compatibility (2026-11-06, PR #775 CI fix): `amenity` expands the closed
`TaxonomyList[].kind` response enum on `GET /cms/taxonomies`. This withdraws a
published guarantee, so use MAJOR 6.0.0-alpha.1 per `git.md`, following BE#747 /
PR #749's `CampaignAudience=public` decision. Record only this finding against
the exact base/revision SHA-256 pair in `.github/oasdiff-exceptions.json`; do not
weaken the checker or relabel the enum as extensible to evade the old contract.
The owner requested this classification and established-pattern fix in-session.
GoGo-CMS uses a closed Zod enum and rejects the whole list with CONTRACT_MISMATCH
on an unknown kind. Before rollout, sync its contract/generated client, runtime
taxonomy enum, kind selector and vi/en labels. Inactive amenity seeds also appear
in the unfiltered list, so deactivation alone does not preserve compatibility.

Deployment: migrations 0080/0081, contract 6.0.0-alpha.1. To avoid unsafe enum
ADD VALUE + seed in the runner's all-pending transaction, 0080 replaces the enum
transactionally with all existing labels plus amenity before seeds. This works on
fresh and existing databases; no special runner or external commit stage required.
It takes a taxonomies table lock; schedule during the normal migration maintenance
window with bounded deployment lock timeout. No bulk associations are fabricated.

Rollback: disable new verification writes and credit-funded sends before rolling
application code back; retain additive schema, balances and audit. Roll forward for
repairs. Do not drop earned-credit tables or restore revoked badges. Integration
specs validate real PostGIS migrations, count eligibility, locks, Home and lifecycle
in CI; no local DB is used. Outstanding balances and count latency require operator
monitoring before widening rollout.
