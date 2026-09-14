# PROF-BE-013 — optional date of birth

Refs #573. OpenAPI 1.0.0-alpha.32, taken from develop's alpha.31. PRs #581 and #582 are also open against alpha.31, so whichever merges later rebases and takes the next alpha.

`GET /me` returns `dateOfBirth` as a calendar date `YYYY-MM-DD`, or null. `PATCH /me` accepts it: omitted keeps, null clears. The value must exist; `2024-02-29` passes and `2027-02-29`, `2026-13-01` or a malformed string return `VALIDATION_FAILED` with field error code `invalid_date`. A date after today in `Asia/Ho_Chi_Minh` returns `too_big`; today there is accepted. No minimum age and no auth or OTP change. A guest gets 403 `USER_ONLY`. The error message never echoes the value.

Storage is a PostgreSQL `date` column, read as text through Drizzle `mode: 'string'`, so no time zone can shift it. Migration 0065 adds it nullable with no default and no backfill; existing accounts read null. The number is 0065 because open PRs #581 and #582 reserve 0063 and 0064. Drizzle skips a migration whose journal `when` is older than the last one applied, so a PR that merges after a higher-numbered migration must raise its `when` above every applied entry before deploy.

Privacy: the value appears only on the owner's `/me` and in the authenticated export, and account deletion nulls it. Room member lists, room summaries, audit values, logs and analytics never carry it. The audit row names the field `dateOfBirth` only. `libs/modules/tsconfig.json` now includes `profile`, so unit specs in that module are linted.

Validation:

| Check                                                      | Result                                   |
| ---------------------------------------------------------- | ---------------------------------------- |
| Unit, full suite                                           | 1,593 passed in 129 files, 6 of them new |
| Integration, `profile.int.spec.ts`                         | 37 passed, 6 of them new                 |
| Typecheck, lint, format, OpenAPI types, routes, boundaries | pass                                     |

The integration suite applies every migration to an empty PostGIS Testcontainer. It covers set, read and clear, omitted keeps, a valid and an invalid leap day, malformed input, tomorrow and today in Hanoi, guest 403, no value in member or room responses or audit, export, deletion, and the nullable no-default column. DEV deployment and client acceptance are pending.

Rollback: revert the application first and keep the additive column. Dropping it is only for an isolated migration rehearsal.
