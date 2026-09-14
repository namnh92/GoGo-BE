-- NTF-BE-014 (#572), ADR-0025. One application-level push switch per account.
--
-- Additive: per-kind rows in notification_preferences are left untouched, so an
-- application rollback reads exactly what it read before. Rehearsal-only down:
-- DROP TABLE notification_settings;
CREATE TABLE notification_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push_enabled boolean NOT NULL,
  source text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_settings_source CHECK (source IN ('explicit', 'migrated', 'legacy'))
);
--> statement-breakpoint
-- Conservative backfill: an account that turned ANY push kind off is off, and
-- stays off until the person turns the switch on. Only an account whose every
-- stored push row was on is on. Accounts with no push rows get no row: they
-- never chose, and "no row" already means on. Email rows play no part.
INSERT INTO notification_settings (user_id, push_enabled, source)
SELECT np.user_id, bool_and(np.enabled), 'migrated'
FROM notification_preferences np
WHERE np.channel = 'push'
GROUP BY np.user_id
ON CONFLICT (user_id) DO NOTHING;
