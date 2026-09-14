-- NTF-BE-014 (#572), ADR-0025 — OPTIONAL rollback hold. Not a migration; never run automatically.
--
-- Run this against the database only when rolling back to the release before
-- 0064 AND the owner wants "any legacy push opt-out disables all push" to keep
-- holding while rolled back. Run it after stopping this release's api and worker
-- and before starting the previous release.
--
-- Without it, an account that made no notification write after the deploy rolls
-- back to its pre-deploy per-kind rows: a mixed account (for example only
-- plan_ready off) gets its other kinds and campaigns again. With it, every
-- account this release does not push to gets a push row set to false for every
-- notification kind, so the previous release pushes nothing to it either.
--
-- Cost: it overwrites per-kind push rows that said true for those accounts. They
-- are the only record of which single kind a person turned off before the
-- switch, and that record cannot be rebuilt afterwards. Idempotent. Email rows
-- and accounts this release pushes to are not touched.
WITH not_pushed AS (
  SELECT ns.user_id
  FROM notification_settings ns
  WHERE ns.push_enabled = false
  UNION
  SELECT np.user_id
  FROM notification_preferences np
  WHERE np.channel = 'push'
    AND np.enabled = false
    AND NOT EXISTS (SELECT 1 FROM notification_settings s WHERE s.user_id = np.user_id)
)
INSERT INTO notification_preferences (user_id, channel, kind, enabled)
SELECT not_pushed.user_id, 'push', k.kind, false
FROM not_pushed
CROSS JOIN unnest(enum_range(NULL::notification_kind)) AS k(kind)
ON CONFLICT (user_id, channel, kind) DO UPDATE SET enabled = false;
