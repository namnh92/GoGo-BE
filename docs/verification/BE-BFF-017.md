# BE-BFF-017 — partial preference matching

Refs #565. Policy and rollback: ADR-0024. Contract alpha.30 adds matching capabilities and explicit incomplete-preference acknowledgement. Two completed responses are required; membership and declared budget/party size remain intact. Draft responses are not used as completed selections. Preference completion and matching transitions synchronize on the room lock; ranking compares input revisions before persisting scores. Late completion invalidates old scores, which cannot be finalized. Only hosts may generate suggestions.

Validation: 1,587 unit tests pass. Room + suggestion/plan integration suites pass (54 tests), then the strengthened room suite passes (30 tests), including actual late completion, stale finalization rejection and rejection of a ranking computed before completion. Typecheck, lint, generated contract check, route coverage and package boundaries pass. Uses isolated local PostgreSQL/PostGIS containers, no DEV data.

Not run: DEV deploy, device acceptance, the full unrelated integration suite. Deploy this before Mobile APP-047. Existing all-complete clients need no new request flag; a partial request without acknowledgement receives a specific conflict. Keep the issue open until acceptance.
