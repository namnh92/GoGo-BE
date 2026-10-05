# ADR-0031: Secure export delivery — encrypted artifact, single-use redemption, auto-delete

- **Status:** accepted (shape decided by SA review, 2026-10-05)
- **Date:** 2026-10-05
- **Deciders:** SA (Astra), product owner
- **Related:** GoGo-BE#256 (BE-CMS-G13), #255 / ADR-0011 (privacy ledger), ADR-0023
  (account deletion), ADR-0022 (storage + cleanup queue), BE#539 (worker leases)

## Context

`POST /cms/privacy-requests/{id}/execute` (export) and `POST /cms/users/{id}/export`
returned the whole export as JSON to the operator. "Delivery" then meant an operator
forwarding it — in practice ordinary email, where the data lives forever. The ledger
already had `delivery_method = secure_download`, with nothing behind it.

**Owner decision 2026-10-05:** there is no path for a subject who cannot sign in.
Account recovery comes first; staff never forward raw data.

## Options considered

1. R2 at-rest encryption only, presigned download link — rejected: an object-store
   compromise is a data compromise; a bearer URL is reusable, scanner-consumable and
   bypasses the BFF (core rule 12).
2. Password-protected ZIP mailed to the user — rejected: distributes passwords, data
   in mailboxes.
3. **Application envelope encryption in private R2, redeemed by an authenticated,
   consume-once BFF POST from the subject's own session** — chosen.

## Decision

1. **Encryption.** Fresh 256-bit data key per artifact; AES-256-GCM, random 96-bit
   nonce, 128-bit tag; AAD = format version + export id + subject id. The data key is
   wrapped (AES-256-GCM, AAD adds the key version) by `EXPORT_WRAPPING_KEY_V<n>` from
   the secret manager. The DB holds wrapped key + nonce/tag + key version; storage
   holds ciphertext. Plaintext and keys exist only in process memory — no temp files,
   no keys in URLs, logs or job payloads. Old key versions stay configured until their
   artifacts are gone; a missing version fails closed (`503 EXPORT_KEY_UNAVAILABLE`).
2. **Redemption.** `POST /v1/me/exports/{id}/download` by the subject's active session
   only. The opaque id grants nothing. GET/HEAD never consume. The session is checked
   against `auth_sessions` (not the Redis denylist). The ciphertext is fetched with a
   byte cap and fully authenticated before a byte is sent; then one short transaction
   locks the user row, rechecks expiry and the export epoch, and moves
   `ready → consumed`. Concurrent or replayed attempts get `410`. Single-use means one
   admitted transfer: an interrupted transfer is not reopened. Admitted transfers get
   60 s. Expiry is **24 h after ready**, immutable.
3. **Export epoch.** `users.export_epoch` is bumped by a DB trigger on any password-hash
   change or transition to `deleted`, and a second trigger revokes every live artifact
   in the same transaction. Direct writes to the epoch are refused. No consumer
   password-change endpoint exists today; the trigger covers future ones.
4. **Delivery path.** BFF-served attachment: `Cache-Control: no-store`, `nosniff`,
   `Content-Disposition: attachment`, no ranges, CSRF for cookie sessions. The route is
   excluded from idempotency response storage; request logs carry no bodies.
5. **Lifecycle.** Table `privacy_export_artifacts` (migration 0070):
   `pending → generating → ready → consumed`, terminal `expired | revoked | failed`.
   The worker claims under a fenced lease (`attempt` is the fencing token), persists an
   attempt-specific object key _before_ upload, and publishes in one transaction that
   rechecks the fence and epoch — publication, ledger completion, the monthly counter
   and an in-app `privacy_export_ready` notification commit together, once. Stale
   attempts cannot publish; their objects go to the media cleanup queue.
6. **Ledger.** The linked request is `in_progress` during generation and closes
   `completed` when the artifact becomes available. `delivered_at` records a
   server-observed completed transfer only; `/delivered` cannot assert
   `secure_download`. CMS execute/direct export return **202 metadata, never data**;
   the direct CMS export creates its own linked request. `GET /me/export` stays for
   compatibility.
7. **Auto-delete.** A one-minute worker sweep expires, times out generation (2 h), and
   deletes due objects with backoff; never marked deleted on storage failure; dead-letter
   after 8 attempts (`privacy_export_cleanup_dead_lettered`) with explicit redrive.
   Consumption, revocation (account deletion) and failure trigger immediate cleanup.
   Confirmed deletion clears every key field; tombstones are removed after 30 days.
   Retention holds on the ledger never extend an artifact. A 2-day R2 lifecycle rule on
   `privacy-exports/` is the orphan backstop (GoGo-Infra follow-up). Audit rows:
   requested, ready, consumed, transfer_completed/aborted, revoked, expired, failed,
   deleted — identifiers and reason codes only.
8. **Limits.** One active artifact per subject (partial unique index + check under the
   user row lock); 3 generations / subject / rolling hour (idempotent replays do not
   count); CMS 10 / 5 min / operator (existing); downloads 10 / h by IP+actor; ≤ 4
   concurrent downloads per API process; worker generates ≤ 2 per tick, serially;
   16 MiB UTF-8 JSON enforced during serialization — oversize fails explicitly, never
   truncates. The R2 reader now enforces its byte cap incrementally.

## Consequences

- CMS clients must handle `202 { request, export }` / `202 { privacyRequestId, export }`
  instead of a payload — a **breaking** CMS contract change (alpha.66).
- Mobile/Web get three new endpoints and a new notification kind.
- Downloaded copies are outside server retention. DB backups may still contain wrapped
  keys from before they were cleared — key clearing is not a claim of crypto-erasure in
  backups. An R2 outage delays physical deletion; BFF access is denied regardless.
- Bounded buffering (≤ 16 MiB per transfer, ≤ 4 concurrent) is the capacity envelope.
- Email notification is not implemented (no email provider exists); in-app only.

## Migration & rollback

Migration 0070 is additive (column with constant default, enum, table, triggers,
notification kind). Rollback = disable issuance (remove `EXPORT_WRAPPING_KEY_*` from
the API so creation answers 503) while the worker sweep keeps running until every
artifact is cleaned; the raw CMS payload is **not** restored. Rehearsal-only down SQL is
in the migration header (exercised in `privacy-export.int.spec.ts`).

## Amendment — SA review of PR #677 (2026-10-05)

- Consumption locks and rechecks the session row (`for share`) and judges expiry
  on `clock_timestamp()` after the locks (F-01, F-05).
- A download's concurrency slot is held until the transfer is finalized (F-02).
- Export collection is paged (500 rows, keyset) and charged against the byte
  budget while rows are read (F-03).
- Every upload attempt writes a durable deletion record
  (`privacy_export_attempt_objects`) before uploading; only publication — inside
  the record's grace (lease TTL + 2 × 30 s upload deadline) — removes it. All other
  attempts' objects are deleted by the sweep after the grace, so a late PUT cannot
  outlive its record (F-04).
- A request backed by an artifact accepts no manual delivery method (F-06).
- The sweep closes a request whose artifact was revoked/failed before it was ready
  as `failed`, once (F-07).
- API and worker read wrapping keys through one generic picker, any `V<n>` (F-08).
