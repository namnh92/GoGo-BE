# Stored provider cover — #822 S1

ADR: [0052](adr/0052-stored-submission-provider-photo.md). Migration:
`0095_submission-provider-photo.sql`. Contract: **9.0.0-alpha.1**.

## Rollout

Apply migrations before API/worker. New flag `place_provider_photo_acquire.enabled`
defaults off (env `FLAG_PLACE_PROVIDER_PHOTO_ACQUIRE=false`); enable by normal CMS
feature-flag configuration. The existing `place_provider_photos.enabled` controls
preview/approval fallback/#797 independently. Keep DEV budget caps unchanged.
New uploads have public, max-age=31536000, immutable; existing objects require S3
header rewrite, not implemented or executed by S1. No provider photo name or
retrieval URL/key is persisted. Public CDN before moderation is owner-authorized
public-unlisted access, with Google credits.

Mobile: remove getPlaceProviderPhotos/query/persist rule, use PlaceDetail.photos;
render submission photo + credits, useCandidatePhoto only for resolve preview;
regenerate client. CMS: regenerate, show providerPhoto in review/queue and explain
implicit Google cover at create; failure requires editor upload. Deploy all in
one DEV window. CODEOWNER migration/OpenAPI approval remains a separate exact-head
gate. Consumer checks and DEV acceptance are not claimed by backend unit tests.

## Lifecycle and checks

Pending cover stays until decided. Approve reuses key. Merge uses #797 eligibility
or retires immediately. Rejection shows photo only before decidedAt + seven days;
marker and delayed cleanup commit together. Worker defers future markers instead
of dropping jobs. Hourly reconciler restores past-due jobs only when no public
queue row exists for the object. Dead-lettered jobs retain their obligation
after six failures and require explicit operator retry. Final CMS
detach retires submission references. Account erasure keeps the submission photo.
Photo metadata is cleared only after origin delete + CDN purge succeed.

S3 owns pending backfill and header rewrite. A maintenance job on the same key is
replaced by scheduleRetirement; future marker causes worker reschedule. No apply
script or budget change is run in S1. #824 owns inheritance and information purge,
informationRemoved, information_purged_at and refresh exclusion.

DEV acceptance: record SHA/build/env, zero google.photoMedia and photoRefs delta
across repeated submission views, CDN credits, Cache-Control on object fetch and
cf-cache-status HIT on second fetch. Stale submission Details refresh remains.

## Rollback — columns last

1. Disable acquire flag; preserve stored metadata and credits.
2. For submission-only keys absent from place_media, atomically mark and schedule
   seven-day retirement. Never pass delayed IDs to attemptNow.
3. Record queue drained for those keys, StoragePort.exists() false per key and
   successful edge purge. Resolve dead letters explicitly; no blind queue delete.
4. Only then write a separate migration dropping provider_photo,
   provider_photo_claim_id, provider_photo_claimed_at, provider_photo_attempts and
   its partial index. Code revert alone keeps credits until cleanup completes.

## Verification outside the sandbox

Run Docker-backed integration specs listed in the implementation report using
`pnpm exec vitest run --project integration <spec paths>`. This includes migration
forward application, shared claims, moderation races, retirement collisions and
CMS/backfill reservation. S3 header-rewrite end-to-end cases run with S3's script;
S1 verifies the required queue/marker primitives. Run fresh oasdiff against the
exact base YAML and revision YAML, then check-contract-compat with
`--expect=BE-822-provider-photos-path-removed`; exactly one ERR is authorized.
