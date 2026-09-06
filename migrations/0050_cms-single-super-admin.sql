-- DB-012 / ADR-0018 — exactly one CMS super_admin per environment.
--
-- The account itself is unchanged by this migration. It keeps its Argon2id
-- hash, its sessions and its MFA enrolment: the database is the authentication
-- source for every CMS account including this one, and SSM holds bootstrap
-- credentials only. Nothing here rotates a password, and a password is not
-- rotated by editing SSM either — that is CMS account management, which audits
-- the change and revokes the sessions it invalidates.
--
-- What this adds is the singleton invariant, in the one place that holds for
-- every writer. The API refuses to create or grant the role, but the API has
-- never been the only thing that writes to this table: the seed did, the
-- bootstrap command does, and a psql session always can. A partial unique index
-- holds for all of them.
--
-- The invariant has two phases, and only the second is "exactly one":
--
--   before bootstrap:  AT MOST ONE   — zero is legitimate, and this index is
--                                      the whole of the enforcement
--   after bootstrap:   EXACTLY ONE   — the account exists and no path can
--                                      remove the role
--
-- At most one is all an index can say. A constraint for the lower bound would
-- have to refuse an empty table, which would refuse the migration that creates
-- it. The lower bound is held instead by the rules around it: bootstrap creates
-- the account, and no mutation path can demote or suspend it away. The
-- transition happens once and is one-way.

-- --------------------------------------------------------------------------
-- 1. Retire any surplus, so the index has something it can build on.
-- --------------------------------------------------------------------------

-- Ordering is by created_at so the outcome does not depend on which row
-- postgres happens to read first: the oldest super_admin is kept and the rest
-- are demoted and suspended. Nothing is deleted — audit rows and moderation
-- history reference these ids, and a deleted actor turns a reviewable history
-- into a set of dangling references.
--
-- Demoted accounts keep their password hash. They are suspended, so it grants
-- nothing; and reactivating one is a deliberate, audited act that should not
-- also have to be a password reset.
--
-- On a database with zero or one super_admin — every environment today — this
-- updates nothing.
update admin_users
   set role = 'editor',
       status = 'suspended',
       updated_at = now()
 where role = 'super_admin'
   and id <> (
     select id from admin_users
      where role = 'super_admin'
      order by created_at asc, id asc
      limit 1
   );

-- --------------------------------------------------------------------------
-- 2. At most one super_admin, enforced by the database.
-- --------------------------------------------------------------------------

create unique index if not exists admin_users_single_super_admin
    on admin_users (role)
 where role = 'super_admin';
