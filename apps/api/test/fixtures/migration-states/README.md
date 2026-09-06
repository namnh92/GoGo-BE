# Migration states a database can already be in

Frozen history, not configuration. Nothing here should ever be edited to make a
test pass: each entry is a state some database really reached, and history does
not change.

## Why they exist

Drizzle decides what to apply by comparing a journal entry's `when` against the
newest `created_at` already recorded — never by filename, never by hash — and it
reads that watermark **once**, before the loop
(`drizzle-orm/pg-core/dialect.js`). So an empty database applies everything in
journal order whatever the timestamps say, while a database with a watermark
silently skips anything stamped below it. A suite that only ever starts empty
cannot see the difference, which is what these fixtures exist to fix.

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

## The states

| Fixture                                    | Watermark it leaves | Note                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push/0045_notification-push-delivery.sql` |       1789084800000 | the push chain alone, before the two provider chains were combined. Byte-identical to the combined `0048_notification-push-delivery.sql`; only the number ever changed                                                                 |
| `link/0044_share-links.sql`                |       1788998400000 | the link chain alone. **Pre-idempotency**: bare `CREATE TYPE`. The combined `0049_share-links.sql` guards them, because its raised `when` makes a link-chain database replay it                                                        |
| `provider` (no files)                      |       1789171200000 | both provider migrations at the `0044`/`0045` numbering they held before the CMS chain took precedence. Same statements, same `when`, different names — so it reads the combined tree through `fromCombined` instead of duplicating it |
| `cms` (no files)                           |       1788675981330 | a database that ran the CMS Place Editor chain (#432/#434) and not this one — the order of record. Those migrations are on develop, so this state reads them through `fromCombined` too                                                |

## Why two states carry no files

`provider` and `cms` both describe databases migrated with statements that still
exist in `migrations/`, under different names or from another chain. They read
those files through `fromCombined` instead of duplicating them: a copy of an
epic this branch does not own would rot the moment that epic changed, and a copy
of this branch's own migration would just be a second place to edit.

Only `push` and `link` need frozen files, because the statements they ran no
longer exist anywhere — the link chain's in particular predates the idempotency
guards that its replay now depends on.

## The state that does not converge

A database that already ran **this** chain sits at 1789171200000, above the CMS
chain's entire range, so when that chain lands its migrations are skipped
permanently — the watermark never comes back down. No numbering fixes it: the
watermark is one value, so only one of the two orders can be made to work, and
CMS-first is the order of record. Such a database needs a forward repair
migration stamped above 1789171200000. The spec asserts this state rather than
hoping for it.

## When to delete this

When every environment has run the combined migrations, no database is in any
prior state and the spec is describing history nothing can be in. Delete the
fixtures and the spec together; keep them while any environment might still be
mid-upgrade.
