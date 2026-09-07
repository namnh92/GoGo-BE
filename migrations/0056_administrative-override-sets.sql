-- ADM-011 (#484) — reviewer adjudication of the advisory mapping source.
--
-- 1,033 rows of the pinned change-mapping upstream are quarantined, every one
-- of them a commune the source says was divided. ADR-0019 forbids guessing
-- which successor a divided commune became, so they sit there until a person
-- decides — and until #484 there was nowhere for that decision to go. The
-- `reviewer_decision` columns on `administrative_mapping_quarantine` were
-- declared in 0051 and never read or written by anything.
--
-- The shape here is the one thing that matters. A decision must not edit the
-- pinned snapshot, must not touch a PUBLISHED dataset, and must not change what
-- the resolver answers the moment somebody clicks. So decisions are append-only
-- rows in a draft set bound to one immutable base dataset, they have no runtime
-- effect at all, and an explicit materialisation turns the accepted ones into a
-- single new STAGED dataset that goes through the ordinary validate → diff →
-- publish path like any import.
--
-- **One draft set per base dataset**, held by a partial unique index. The
-- combined checksum is a pure function of the four pinned source checksums plus
-- `override_revision`, and both the version string and the checksum are unique
-- — so two draft sets on the same base would both mint `r+1` and the second
-- would be refused by that index after copying 24,000 rows. The next round of
-- review opens a set against the *derived* dataset instead, which is also what
-- makes the revision sequence readable: r0 → r1 → r2.
--
-- Append-only is literal. Nothing ever rewrites a decision's content. The one
-- column a later statement touches is `superseded_by_id`, written by the
-- decision that replaces it inside the same transaction, and it exists so that
-- "one effective decision per quarantine row" is a database constraint rather
-- than a rule the application has to remember.
--
-- ---------------------------------------------------------------------------
-- Down:
--   ALTER TABLE administrative_unit_changes DROP COLUMN override_decision_id;
--   DROP TABLE administrative_mapping_override_decisions;
--   DROP TABLE administrative_mapping_override_sets;
--   DROP TYPE administrative_override_decision;
--   DROP TYPE administrative_override_set_status;
-- Backing out loses the reviewer decisions and the link from a materialised
-- edge to the decision that made it. It restores nothing, because nothing that
-- existed before was changed: the quarantine rows, the units and the canonical
-- changes of every existing dataset are untouched by this migration.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE administrative_override_set_status AS ENUM (
    'DRAFT', 'MATERIALIZED', 'ABANDONED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Two outcomes, not three. "Superseded" is the relationship between two
-- decisions, not an outcome a reviewer chooses — making it a third value would
-- ask them to distinguish "I reject this mapping" from "I withdraw my earlier
-- opinion", which is a question about bookkeeping rather than about geography.
DO $$ BEGIN
  CREATE TYPE administrative_override_decision AS ENUM ('ACCEPT', 'REJECT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS administrative_mapping_override_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_dataset_id uuid NOT NULL
    REFERENCES administrative_dataset_versions(id) ON DELETE CASCADE,
  -- Incremented by every appended decision. This is the value a mutation must
  -- send back, so two reviewers deciding at once cannot silently overwrite each
  -- other: the loser is told the set moved and re-reads it.
  revision integer NOT NULL DEFAULT 0,
  status administrative_override_set_status NOT NULL DEFAULT 'DRAFT',
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The one dataset this set produced. Set exactly once, with the status.
  materialized_dataset_id uuid REFERENCES administrative_dataset_versions(id),
  materialized_at timestamptz,
  materialized_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  abandoned_at timestamptz,
  abandoned_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  abandoned_reason text,
  CONSTRAINT administrative_override_sets_materialized_pair CHECK (
    (status <> 'MATERIALIZED')
    OR (materialized_dataset_id IS NOT NULL AND materialized_at IS NOT NULL)
  ),
  CONSTRAINT administrative_override_sets_abandoned_pair CHECK (
    (status <> 'ABANDONED')
    OR (abandoned_at IS NOT NULL AND length(btrim(coalesce(abandoned_reason, ''))) > 0)
  )
);--> statement-breakpoint

-- At most one draft per base. See the header for why this is identity and not
-- merely tidiness.
CREATE UNIQUE INDEX IF NOT EXISTS administrative_override_sets_one_draft
  ON administrative_mapping_override_sets (base_dataset_id)
  WHERE status = 'DRAFT';--> statement-breakpoint

-- A dataset is the product of at most one set, so the link is unique too.
CREATE UNIQUE INDEX IF NOT EXISTS administrative_override_sets_materialized_unique
  ON administrative_mapping_override_sets (materialized_dataset_id)
  WHERE materialized_dataset_id IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_override_sets_base_idx
  ON administrative_mapping_override_sets (base_dataset_id, status);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS administrative_mapping_override_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  override_set_id uuid NOT NULL
    REFERENCES administrative_mapping_override_sets(id) ON DELETE CASCADE,
  quarantine_row_id uuid NOT NULL
    REFERENCES administrative_mapping_quarantine(id) ON DELETE CASCADE,
  -- Denormalised so a decision can be read, and audited, without walking back
  -- through the set to find out what it was about.
  base_dataset_id uuid NOT NULL
    REFERENCES administrative_dataset_versions(id) ON DELETE CASCADE,
  -- Position within the set. Append-only order, and what the revision counts.
  sequence integer NOT NULL,
  decision administrative_override_decision NOT NULL,
  -- The target the reviewer named. A code alone is not an identity — 2,212 of
  -- the 3,321 current commune codes changed meaning on 2025-07-01 — so the
  -- effective period travels with it, and `target_identity` keeps the whole
  -- unit as it read at decision time.
  target_code text,
  target_effective_from date,
  target_identity jsonb,
  reason text NOT NULL,
  -- The quarantine row and its candidates as they were. A decision has to stay
  -- readable as evidence on its own, months later, without re-deriving what the
  -- source said.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  supersedes_decision_id uuid
    REFERENCES administrative_mapping_override_decisions(id) ON DELETE SET NULL,
  -- Written once, by the decision that replaces this one, in that decision's
  -- own transaction. The only column on this table that is ever updated.
  --
  -- DEFERRABLE because the back-pointer has to be written *before* the row it
  -- points at exists: the partial unique index below allows one row per
  -- quarantine row with a null `superseded_by_id`, so inserting the replacement
  -- first would momentarily leave two and the index would reject the append.
  -- Update-then-insert satisfies the index at every statement, and the deferred
  -- check settles the reference at commit.
  superseded_by_id uuid
    REFERENCES administrative_mapping_override_decisions(id) ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT administrative_override_decisions_accept_target CHECK (
    decision <> 'ACCEPT'
    OR (target_code IS NOT NULL AND target_effective_from IS NOT NULL)
  ),
  -- A decision nobody explained cannot be reviewed later, which is the whole
  -- point of keeping it.
  CONSTRAINT administrative_override_decisions_reason CHECK (
    length(btrim(reason)) > 0
  ),
  CONSTRAINT administrative_override_decisions_not_self CHECK (
    supersedes_decision_id IS NULL OR supersedes_decision_id <> id
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS administrative_override_decisions_sequence
  ON administrative_mapping_override_decisions (override_set_id, sequence);--> statement-breakpoint

-- Exactly one effective decision per quarantine row per set. Superseded rows
-- stay, and stay out of this index.
CREATE UNIQUE INDEX IF NOT EXISTS administrative_override_decisions_effective
  ON administrative_mapping_override_decisions (override_set_id, quarantine_row_id)
  WHERE superseded_by_id IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_override_decisions_set_idx
  ON administrative_mapping_override_decisions (override_set_id, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_override_decisions_row_idx
  ON administrative_mapping_override_decisions (quarantine_row_id);--> statement-breakpoint

-- Which decision produced this edge, or NULL for one the pinned upstream
-- asserted. It is what lets the diff say "a reviewer decided this" instead of
-- reporting a GoGo decision as an upstream fact, and what binds a materialised
-- edge to the audit row behind it.
--
-- Nullable with no default, so PostgreSQL adds it without rewriting the table.
ALTER TABLE administrative_unit_changes
  ADD COLUMN IF NOT EXISTS override_decision_id uuid
    REFERENCES administrative_mapping_override_decisions(id) ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS administrative_unit_changes_override_idx
  ON administrative_unit_changes (dataset_version_id)
  WHERE override_decision_id IS NOT NULL;
