# Migration states these chains shipped before they were combined

Frozen history, not configuration. Nothing here should ever be edited to make a
test pass: each file is a copy of a migration exactly as one of the two provider
chains shipped it, and history does not change.

## Why they exist

The push chain (#193/#199) and the link chain (#204–#206) were built side by
side and both numbered from 0044. Drizzle decides what to apply by comparing a
journal entry's `when` against the newest `created_at` already recorded — never
by filename and never by hash — so combining them renumbers one migration and
raises its `when`. That makes a database which already ran _one_ chain a
different upgrade path from an empty one, and only an empty one is exercised by
a normal test run.

`apps/api/test/migration-upgrade.int.spec.ts` rebuilds each prior state from
these files plus the shared migrations at or below `baseThroughIdx`, which are
identical in every state and are read from `migrations/` rather than duplicated
here.

## Why files and not git

The spec first resolved these states by walking merge commits. That cannot
survive the way this repository merges: `feature/*` branches are squash-merged,
so the merge commits stop existing, and the CI job that runs integration tests
checks out at depth 1 with no `origin/develop` ref to walk from. Fixtures on
disk survive a shallow checkout, a squash merge, a rebase, and the deletion of
every branch involved.

## The two states

| Fixture                                    | Was               |        `when` | Note                                                                                                                                                                                |
| ------------------------------------------ | ----------------- | ------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push/0045_notification-push-delivery.sql` | push chain's 0045 | 1789084800000 | byte-identical to the combined `0044_notification-push-delivery.sql`; only the number changed                                                                                       |
| `link/0044_share-links.sql`                | link chain's 0044 | 1788998400000 | **pre-idempotency**: bare `CREATE TYPE`. The combined `0045_share-links.sql` guards them, because raising its `when` above the push migration makes a link-chain database replay it |

The spec asserts both relationships, so editing either migration without
thinking about the upgrade path fails the suite rather than passing quietly.

## When to delete this

When every environment has run the combined migrations, no database is in
either prior state and the spec is describing history nothing can be in. Delete
the fixtures and the spec together; keep them while any environment might still
be mid-upgrade.
