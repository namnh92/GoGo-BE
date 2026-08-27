-- BE-BFF-016 (#171) — the client-facing upload path.
--
-- Check-in already accepted `photoKeys` and `billPhotoKey`: keys of objects
-- that were supposedly already uploaded, with nothing in the contract able to
-- produce one. This table is what makes a key mean something — it binds the
-- key to the actor who asked for it, to a purpose, and to an expiry.
--
-- Without it a presigned upload would be an unowned string: any member could
-- attach any key, including one from another member's upload.

create table if not exists media_uploads (
  id uuid primary key default gen_random_uuid(),
  storage_key text not null unique,
  -- Which actor may later reference this key. Guests included: a guest checks
  -- in on its own room, so it must be able to attach its own photo.
  actor_type text not null,
  actor_id uuid not null,
  purpose text not null,
  content_type text not null,
  content_length integer not null,
  -- pending → attached. Never "uploaded": the API does not see the bytes land,
  -- and claiming a state it cannot observe would be a lie in the data.
  status text not null default 'pending',
  attached_to_type text,
  attached_to_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  attached_at timestamptz
);

-- The lookup on every check-in: is this key this actor's, and still usable.
create index if not exists media_uploads_actor_idx
  on media_uploads (actor_id, status, expires_at);

-- Reclaiming keys that were presigned and never used.
create index if not exists media_uploads_expiry_idx
  on media_uploads (expires_at) where status = 'pending';

-- #171 — check-in tags were `string[]` with no taxonomy, so Mobile had to
-- define the vocabulary locally. This lets the CMS own it like every other
-- one, and keeps stored values as stable keys rather than a localised label
-- that would store "Muốn đi lại" for one user and "Would go again" for
-- another and make the column unqueryable.
--
-- Recreated rather than `ALTER TYPE ... ADD VALUE`: the migrator runs every
-- file in one transaction, and Postgres refuses to *use* a value added to an
-- already-committed enum before that transaction commits ("unsafe use of new
-- value"). A type created inside the transaction has no such restriction, so
-- the seed in 0015 can reference it. `taxonomies.kind` is the only column on
-- the type.
alter type taxonomy_kind rename to taxonomy_kind_old;
create type taxonomy_kind as enum (
  'mood', 'category', 'setting', 'dietary',
  'accessibility', 'spending_style', 'suitability', 'checkin_tag'
);
alter table taxonomies
  alter column kind type taxonomy_kind using kind::text::taxonomy_kind;
drop type taxonomy_kind_old;

-- Rollback:
--   drop table if exists media_uploads;
--   delete from taxonomies where kind = 'checkin_tag';
--   then recreate taxonomy_kind without the value the same way this migration
--   added it, and re-point taxonomies.kind at it.
