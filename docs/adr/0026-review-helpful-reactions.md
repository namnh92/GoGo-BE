# ADR-0026: One "helpful" reaction on published reviews, and a helpful-first preview

- **Status:** accepted — the product owner approved the reaction policy on 2026-09-14 (see _Owner approval_)
- **Date:** 2026-09-14
- **Deciders:** product owner (policy), backend (contract, migration)

## Context

GoGo-BE#571 (BE-BFF-019) asks for reactions on reviews and a top three ranked by
them, after the latest-three preview of BE-BFF-018 (#570). The issue itself says
the reaction type, permissions, uniqueness, add/remove semantics and tie-break
must be settled before implementation.

Nothing in the product documents settles them. `GOGO_SRS.md` defines reviews
(FR-PLAN-007/008, FR-USER-002) and their moderation (FR-CMS-005), and no
reaction, "helpful", "hữu ích" or like of any kind. The Mobile consumer is
GoGo-MobileApp#219 (APP-060). This record therefore proposes a policy; nothing
here was previously decided. The product owner approved it on 2026-09-14.

## Options considered

1. **Several reaction types** (like, love, funny…) — richer, but every type
   needs a meaning, a ranking weight and copy, none of which exists, and the
   issue warns against treating unlike reactions as one semantic.
2. **One `helpful` reaction** — one question a reader can answer ("did this help
   you decide?"), one count, one unambiguous ranking. Chosen.
3. **Up/down votes** — a down vote is a moderation signal in disguise and needs
   abuse rules of its own; reports already exist for that.

## Owner approval (2026-09-14)

The product owner approved, in these words' substance:

- Helpful reactions require sign-in.
- At most one mark per account per review.
- Marking your own review is prohibited.
- A mark can be removed.
- Ranking is by mark count descending, then the newest review creation date.

Those settle decisions 1, 2, 3, 5 and 8 below. `id desc` stays in decision 8 only
as the final tie-break for two reviews created at the same instant, so the order
is deterministic; it never outranks count or creation date. Decisions 4, 6, 7, 9
and 10 apply rules that already existed — moderation (FR-CMS-005), the
per-action rate limits in `.claude/rules/security.md`, and ADR-0023's retention
list — and the owner did not rule on them separately.

## Decision

1. **Type.** One reaction, `helpful`. Stored as text with a CHECK, so adding a
   type is a deliberate migration plus a new decision, never a silent enum value.
2. **Who.** Signed-in accounts only. Guests and anonymous readers see counts;
   a guest write answers `403 USER_ONLY`, an anonymous one `401`.
3. **Not on your own review.** `403 OWN_REVIEW`. Counting your own review
   helpful is not a signal.
4. **Only published reviews of a place Place Detail opens.** Any other status (`pending`, `rejected`,
   `removed`, `hidden`) answers `404 REVIEW_NOT_FOUND`, the same as a review that
   does not exist, so the write path cannot probe moderation state.
5. **One per person per review.** Primary key `(review_id, user_id, type)`.
   `PUT /reviews/{id}/reactions/helpful` adds and `DELETE` removes. Both are
   idempotent and answer the resulting state `{ reviewId, helpfulCount,
reactedByMe }`; a double tap, a retry or a replayed request never counts twice.
6. **Counts are derived, not stored.** `helpfulCount` is `count(*)` over the
   reaction rows, read in the same transaction as the write that precedes it.
   There is no counter column to drift from the rows. If volume ever demands a
   stored counter, it is added with a backfill and this record is superseded.
7. **Abuse.** Per-actor rate limit `reviews.react`: 120 per hour with a burst
   of 30 per minute. Idempotency makes repetition harmless; the limit bounds
   churn.
8. **Ranking.** `GET /places/{id}/reviews?order=helpful` orders by
   `helpfulCount desc, createdAt desc, id desc`. With no reactions at all this is
   exactly the `latest` order, which is the fallback. `order` defaults to
   `latest`, so BE-BFF-018 clients see no change.
9. **Moderation wins.** Only `published` reviews are ranked, in either order.
   Reactions on a review that is later hidden, removed or edited back to
   `pending` are kept but count nowhere while it is not published; if a
   moderator re-publishes it (an overturned takedown), its count returns.
10. **Privacy.** No public response names a reactor, only counts. A person
    reads their own reactions through `GET /me/review-reactions?placeId=`.
    Export (`GET /me/export`) lists them. Account deletion removes them: they are
    personal signals, not contributions, and not on ADR-0023's retention list,
    so the counts they added go with them.

## Consequences

- Clients get one toggle with a count and no per-type copy.
- The preview gains an optional `order` and each review a `helpfulCount`; both
  are additive.
- Ranking costs one correlated count per candidate review of one place; fine at
  current volume, revisited with decision 6 if it is not.
- The owner-approved policy is the acceptance bar for GoGo-BE#571 and GoGo-MobileApp#219; the issues close only after DEV and device acceptance.

## Migration & rollback

Migration `0066_review-reactions` only creates `review_reactions` (additive, no
rewrite of `reviews`, no long lock). Application rollback leaves the table
unused and harmless. Rehearsal-only down: `DROP TABLE review_reactions;`.
Deploy BE before Mobile APP-060; Mobile must not show the control against an API
that lacks it.
