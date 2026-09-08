# ADR-0020: Provider facts on a place an editor creates from a link

- **Status:** accepted
- **Date:** 2026-09-08
- **Deciders:** product owner, backend, CMS

## Context

`POST /cms/places` has accepted a `googlePlaceId` since GoGo-BE#465, and the
console's create form is opened from a Google Maps link. The resolve behind that
form fetches Place Details at the `quality` tier — the mask has carried
`rating`, `userRatingCount`, `regularOpeningHours`, `priceLevel` and
`googleMapsUri` since ADR-0006 §2 — and then discards all of it. The place that
is created holds a name, an address, a coordinate and a Place ID.

So `GET /cms/places/{id}` comes back with no rating, no review count, no opening
hours and no canonical Google link: precisely the facts the editor was shown
seconds earlier, missing from the row that preview created. GoGo paid for them.

Two documents pull in opposite directions on whether to keep them.

`GOGO_PRODUCT_DATA_ARCHITECTURE.md` §2 rows "Google rating/reviews/photos/hours"
as **Persist GoGo: No by default**, and §9 forbids making GoGo a Google Places
mirror or using Google ratings as a recommendation foundation. `placeCreateLink.view.tsx`
in GoGo-CMS carries a comment refusing to apply the rating, citing that row.

`develop` has meanwhile persisted exactly these fields on a different door for a
long time: `createDraftFromSubmission` writes `places.rating`, `rating_count`,
`price_level` and the whole weekly `place_hours` table from a `quality` fetch
when a moderator approves a Mobile submission, and `upsertProviderSource` writes
`provider_uri`, the aggregates, the primary type and the attribution. The
document and the code already disagreed; the CMS door was the one obeying the
document, and it is also the door where the omission is most visible.

## Options considered

1. **Persist nothing.** Consistent with §2 read literally. Leaves the CMS door
   unable to show what the preview showed, and leaves the two creation doors
   behaving differently for no reason a user could infer.
2. **Let the client post the previewed values.** No extra provider call. But the
   server cannot check them: an editor — or anything holding an editor session —
   could store an invented number that Place Detail would then render under
   Google's attribution. Core rules 8 and 14 exist to stop exactly that.
3. **Persist, as the provider's own facts, from a server-side fetch.** One
   `quality` Details call at create, values written where provider facts already
   live, attributed, never GoGo-owned.

## Decision

Option 3.

`POST /cms/places` with a `googlePlaceId` makes exactly one `quality` Place
Details call and stores what it returns:

| Value                                         | Where                                  | Meaning                                                                                         |
| --------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| rating, review count                          | `places.rating`, `places.rating_count` | the provider's figures, rendered beside GoGo's own and never averaged with them (FR-INGEST-006) |
| price level                                   | `places.price_level`                   | the provider's grade                                                                            |
| weekly hours                                  | `place_hours`, `source = 'provider'`   | GoGo's existing representation; no new schedule model                                           |
| canonical link, aggregates, tier, attribution | `place_provider_sources`               | the row that already owns provider provenance                                                   |

Three properties make this compatible with the data architecture rather than a
reversal of it:

- **Ownership does not move.** A value stored here is the provider's, marked as
  the provider's, and carries its attribution and fetch time. Nothing about
  copying it makes it GoGo-owned — the provenance rule at the head of
  `GOGO_PRODUCT_DATA_ARCHITECTURE.md` still holds, and a GoGo-owned canonical
  fact still requires independent provenance naming a non-Google origin.
- **Nothing downstream reads it as GoGo knowledge.** Recommendation retrieval,
  scoring and the itinerary optimiser do not consult `places.rating`; §9's
  guardrails are about what the pipeline is built on, and this changes nothing
  there.
- **The editor cannot author it.** The values come from the provider answer this
  request made, never from the request body. There is no field an editor could
  fill to put a number of their own under Google's name.

The provider call is made at create rather than carried from the resolve because
ADR-0006 §9.5 forbids the server holding provider content across requests; there
is deliberately no snapshot to replay. This is the same reasoning, and the same
code path, as the submission approve step.

`GOGO_PRODUCT_DATA_ARCHITECTURE.md` §2's "No by default" is therefore read as
what it says — a default, not a prohibition — and this ADR is the record of the
place where it is overridden, for these four values, on this door, with
attribution.

## Consequences

- One extra Place Details call at `quality` per place created from a link. It is
  bounded by editor typing speed, already counted by the existing provider
  request and duration metrics, and priced on the same row of ADR-0006 §2 as the
  preview.
- A provider that is unreachable, out of quota, does not know the id, or answers
  about a different id (a place that moved) costs the enrichment and not the
  place: the row is created with its identity and no provider facts, which is
  the state every place created before this change is already in.
  `cms_place_create_provider_enrichment_total{result}` separates those outcomes,
  because "this place has no rating" and "Google was unreachable for an hour"
  are indistinguishable in the data otherwise.
- Place Detail can render the canonical `googleMapsUri`, so a place created from
  a link can be opened in Google Maps. Previously nothing wrote `provider_uri`
  on this door at all.
- The two creation doors now agree. A place added by an editor and one approved
  from a Mobile submission carry the same provider facts in the same columns.
- Nothing changes for a place created without a `googlePlaceId`: no provider
  call is made and no provider fact is stored.

## Migration & rollback

No migration. Every column and table this writes to already exists and is
already written by the submission path.

Places created from a link before this change keep their identity and gain
provider facts the next time `PlaceRefreshService` reaches them; nothing
backfills them here, and this ADR authorises no backfill.

Rollback is deleting the `providerSnapshot` call in `CmsCatalogService.createPlace`.
Rows already written stay valid — they are ordinary provider-sourced rows,
indistinguishable from ones the submission path wrote.
