# BE-BFF-P2 (#218) — report wrong place information

Refs #218. Consumer: GoGo-MobileApp APP-029 (#82), whose `Báo thông tin sai` control is shown unavailable until this ships. Contract alpha.58 (renumbered at merge). No migration.

Behaviour: `POST /places/{id}/reports` with `{ reasonCode, note? }` writes one row into `reports` (`target_type = place`, status `open`). That table already feeds the CMS queue `GET /cms/moderation/reports` (BE-CMS-G1, #219), so moderators see it there with `reporterKind: user | guest`. Decisions stay in `CmsOpsService`. There is no second queue.

- Who can report: an app account or a room guest. A CMS admin token gets `403 REPORTER_NOT_ALLOWED` and an anonymous call gets `401`. A place that Place Detail does not open (anything except `published` and `community_submitted`) gets `404 PLACE_NOT_FOUND`, the same answer as a missing place.
- `reasonCode` is one of `wrong_hours`, `wrong_price`, `wrong_location`, `permanently_closed`, `other`. The contract marks the set `x-extensible-enum`, so adding a key later does not break clients. The server refuses any value outside the set with `400 VALIDATION_FAILED`.
- `note` is optional. CRLF is normalised to LF, then the note is trimmed and capped at 500 characters (the cap applies after trimming). Control characters other than tab and line feed, including NUL, are refused with `400` and a `note` field error. A blank note is stored as no note. It goes to moderators only: the response does not echo it and the logs never contain it.
- Repeat reports: while the same actor has an open report with the same reason on the same place, the endpoint files nothing and returns that report with `200`. A new report returns `201`. A different reason counts as a separate report. Once a moderator decides a report, the next one is filed as new. The place row is read `FOR NO KEY UPDATE` inside the transaction (this mode does not block foreign-key inserts that reference the place, review F-04), so simultaneous identical submissions file exactly one report (review F-01). An `Idempotency-Key` replay returns the original status: a duplicate's 200 stays 200 (F-02). This needed a fix to the shared `IdempotencyInterceptor`, which now records the status the reply actually carries instead of turning every POST 200 into 201; an ordinary creating POST is still recorded as 201, and `POST /rooms/{id}/preferences/complete` (`@HttpCode(200)`) now replays 200 instead of 201 (F-05).
- Rate limit `places.report`, keyed per actor: 5 per minute, 20 per hour.
- The response returns facts only: `{ id, placeId, reasonCode, status, createdAt }`.

Rollback: revert the application change. Rows already filed stay in the moderation queue, which already handles them.

Not run: DEV deploy, device acceptance. Keep the issue open until APP-029 is wired and acceptance passes on DEV.
