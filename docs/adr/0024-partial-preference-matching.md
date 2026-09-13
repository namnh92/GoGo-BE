# ADR-0024 — explicit matching with incomplete preferences

Status: implementation proposal for review (BE-BFF-017 / Mobile APP-047).

The feedback asks for an escape from waiting forever without removing members. Requiring everyone forever leaves that defect; silently excluding people changes party size and budget. The proposed default is at least two completed responses, with an explicit host acknowledgement when joined members remain incomplete. There is no automatic timeout or fabricated preference/vote.

Expose completion counts, capability and blocked reason in RoomSummary. Validate the acknowledgement and quorum on the server when entering matching. Keep every active member in the snapshot and the declared participantCount unchanged; incomplete/draft selections contribute no selected preferences. They retain membership and voting rights. Late completion invalidates scores so the host can regenerate. Only hosts generate suggestions.

Existing all-complete flows need no new flag. Partial starts send allowIncompletePreferences=true on the status transition. Unacknowledged incomplete starts return PREFERENCES_INCOMPLETE; fewer than two complete responses return MATCHING_QUORUM_REQUIRED. Room status and quorum are checked under the same room lock as the transition. No schema migration. Rollback reverts API and client together; existing matching rooms remain readable.

Traceability: FR-PREF-005, FR-SUG-003/004, GoGo-BE#565, GoGo-MobileApp#200. This record does not declare device acceptance.
