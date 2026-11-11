# Deleted-conversation SSE admission

Pre-existing on the owner-supplied base `8ee29556`: GitHub file reads confirmed
the same assistant stream controller, asynchronous message admission check and
Nest 11.2.3 lockfile version. No git commands were used. This is a source-level
base comparison, not a full base-checkout integration run.

History uses `AssistantConversationsService.requireConversation`; stream uses
`AssistantStreamService` and the repository's owner/retention-filtered
`findMessage`. Both already throw `404 NOT_FOUND`. With a global interceptor,
Nest can commit SSE headers while the handler still awaits that lookup, turning
the eventual refusal into an HTTP 200. Redis replay does not bypass the lookup:
the buffer is keyed by message ID and depends on database authorization. Its
purge/tombstone behavior is unchanged.

`AssistantStreamGuard` now validates IDs and calls the existing
`requireAssistantMessage` before SSE setup. Missing, deleted, expired and foreign
rows receive the normal JSON error envelope. The stream service retains its
admission and live-row checks; active readers and sequence-based resume keep
their existing behavior. Each admitted attachment adds one database lookup.

Regression evidence: the in-process Nest/Fastify HTTP tests with delayed
repository reads failed before the guard (three 200-versus-404 assertions) while
both live/resume controls passed. All five pass after the guard. These tests keep
buffered content present during refusal. Two focused service cases also prove
refusal before buffer reads and slot release across repeated failures. The
original deletion integration regression now checks JSON envelope parity with
history and resume with `Last-Event-ID`.

Historical validation before round-1 fixes: assistant unit suite plus HTTP regression: 594 tests / 34 files
passed. Final focused rerun after test typing fixes: 8 tests / 2 files passed.
`pnpm typecheck` passed across all eight packages. Targeted ESLint and Prettier
passed. Full integration execution is unavailable in this sandbox:
Docker socket access is denied and local TCP listen returns EPERM. The HTTP unit
regression uses Fastify injection; only its synthetic socket's TCP tuning methods
are supplied by the harness.

Round-1: the guard, controller wiring, delayed HTTP regressions and service
admission cases were restored from reviewed head `89483f35` after the supplied
rebase omitted them. Current commands/results and the final content snapshot
are in [validation.md](856-evidence/validation.md); historical counts above do
not apply to this worktree snapshot.
