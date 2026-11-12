# ADR-0055 — Reference-only place QA and atomic read rendering

- Status: S1 compatibility floor implemented; projection, emission and enablement pending.
- Date: 2026-11-11
- Scope: GoGo-BE#856, S1 of #844. Amends [ADR-0036](0036-assistant-openrouter-jev-haiku-byok.md).
- Authority: Astra rev3, `dev/handoffs/sa-shape-be-844-ai-place-qa.rev3.astra.md`
  §§3.3–3.5, 7–11; owner BE#844 decisions dated 2026-11-11.

## Context and decision

The assistant needs deterministic, server-decided `place_qa` answers without a
model's factual claims or persistent copies of place data. A stored fact sentence
would become stale and could persist provider content. Independently hydrating
text, compare cards and sources can contradict one another within a response.

Persist only versioned semantic queries, IDs, keys and non-value trace metadata.
The route and classifier belong to S3; S1 does not choose routes or emit answers.
S2 implements `PlaceFactsReader.placeFacts` with one batched statement and the
field-specific verification/provenance/freshness policy from rev3 §3.4. There is
no production projection binding or fallback adapter in S1. A missing binding is
a read error, never absence or an unavailable place.

One immutable `PlaceFactContext` serves the whole response group. Live SSE waits
for committed frames. Reconnect loads every group reference before selecting
the suffix after `Last-Event-ID`. History/CMS load at most 30 distinct IDs in one
batch; overflow groups use neutral identity/topic labels and minimal label cards,
without another hydration. Overflow `available:true` keeps the existing card
navigation contract; it conveys no opening/price/status fact. Preview/snippets
use a separate bounded identity-only read. Stored export uses public ID/query
labels without reading facts. Truncation preserves whole private references.

This is a narrow exception to “DTOs return facts, not composed sentences”: only
assistant conversational text uses server templates. Other domain DTOs and card
facts retain their existing contracts. Patterns/templates are code-reviewed and
not editable in CMS. CMS displays current eligible facts, never evidence of what
was displayed when feedback was submitted. User messages retain the existing
retention policy. No model prompt or provider response is persisted by S1.

## Format, failures and deadlines

See [the S1 format and handoff](../plans/856-place-answer-readers.md) for the closed
grammar, reference group, port obligations and schema activation sequence.
Unknown/malformed tokens are neutral and never trigger an unvalidated lookup.
An unavailable projection yields an unavailable minimal card. Read errors or
render deadlines yield fixed localized load-error text and no cards/sources/
options; SSE emits the existing error envelope instead of a false successful
`done`. Producer completion remains persisted and is distinct from delivery.

The reader deadline is 2 seconds including projection work. Attached live reads
use the smaller of that and the remaining first-visible allowance from accepted
turn time. An expired allowance makes no fact read. Reconnect/history/CMS have
their own 2-second allowance. Reader cancellation affects only its read; stop,
delete and producer settlement retain existing behavior. Token-ready and first
rendered delivery have separate metrics with closed labels and no identifiers.

Q-2 authorizes missing-price wording for direct questions (including a missing
side of an explicit price compare). It never authorizes an unverified price.
Q-1a/Q-1b remain S6/S7; they do not expand S1.

## Alternatives and consequences

Persisting rendered snapshots is rejected for privacy and freshness. Rendering
frames independently is rejected for inconsistent facts and unbounded reads.
A generic `available:false` for DB failures is rejected because it misrepresents
an error as a catalogue verdict. A fake production projection is rejected.

Once any answer reference is written, S1 is the minimum deployable reader
version. Rollback switches off new emission, retains compatible readers and
stored references, and never deploys a pre-S1 binary. S3 ships dark; enablement
requires S4 + S5 and generated-client/source-bound consumer proof. This ADR is
not DEV acceptance, independent review, CI, merge or deployment approval.

## Round-1 clarification

`PlaceFactsReader` is the canonical S1/S2 boundary. A complete weekday contains
intervals with independent `VerifiedFact` evidence, preserving dates and tiers
adjacent to each interval; inconsistent schedules or missing interval evidence
are suppressed as a whole. S2 must adapt its internal projection and bind
`PLACE_FACTS_READER`; it must preserve the required absolute deadline, immutable
map, error/cancellation semantics and field policy without fabricated evidence
or duplicate duration metrics. The exact shapes are in `place-facts.ts`.

The runner persists its immutable `streamRoute` before buffer publication.
Ordinary readers classify once and retain periodic lifecycle checks. A live
attachment timer bounds buffer/metadata waits as well as fact rendering; expiry
is reader-only and leaves producer settlement unchanged.

## S3 amendment — 2026-11-12, BE #873

The [Astra S3 amendment](../plans/sa-shape-be-844-ai-place-qa.rev3-amend-s3.astra.md)
raises the compatibility floor beyond S1: all recommendation history/episode
readers must understand terminal `qaProbe` associations. Pause new sends and
drain old runners, install that floor everywhere, verify all serving instances,
then resume sends. Pre-floor readers such as `0dd18c5e` can leak the user partner
of a probe that a legacy finalizer preserves. They may not coexist with this
writer or serve rollback traffic, even with the QA flag off. Rollback retains
the marker-aware floor and disables emission. S4 + S5 and owner enablement
requirements remain unchanged.

Unknown flag reads default disabled for the turn. Deadline settlement is a
cancellable transaction with one 1.5-second total cleanup allowance; failure
retains exclusion uncertainty without a QA route. Text-only confirmation uses
full name + current area, revalidates catalogue uniqueness and never uses a
probabilistic code. Structured clients retain source-bound ids.
