-- NTF-BE-002 (#193) review fix — per-recipient push delivery progress.
--
-- A notification row is the inbox record and was also treated as "push already
-- sent": the campaign dispatcher inserted it before calling the provider and
-- skipped any recipient whose row already existed. Two things follow from that
-- when a provider outage aborts a send half-way:
--
--   - the recipient the outage hit has a row and no push, and is never retried;
--   - rescheduling minted a fresh dispatch key, so everyone already pushed got a
--     second row and a second push.
--
-- The inbox row and the delivery fact are now two different columns. A row
-- with push_sent_at is done; a row without it is owed a push. Rescheduling a
-- failed campaign reuses its dispatch key, so the rows line up and only the
-- incomplete sends run.
--
-- Down:
--   ALTER TABLE notifications DROP COLUMN push_message_id, DROP COLUMN push_sent_at;
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS push_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS push_message_id text;
