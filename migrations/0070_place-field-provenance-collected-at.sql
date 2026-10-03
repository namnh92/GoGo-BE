-- GoGo-BE#280 (owner decision 2026-10-02, option A; ADR-0031). address_text,
-- phone and website are GoGo-owned place data, and an independently sourced
-- write must say when its evidence was gathered — not only when it was typed.
--
-- Additive and short-lock: one nullable column with no default, which Postgres
-- records in the catalog without rewriting or scanning the table. No backfill:
-- a legacy row has no collection time because nobody recorded one, and
-- inventing it would turn "someone typed this" into evidence.
--
-- Rollback is application-only: older code neither reads nor writes the
-- column, so it is left in place and the evidence it holds is retained.
--
-- Guarded on the table existing: a history whose watermark skipped the CMS
-- chain (0046; the provider-chain-first state named in ADR-0016 and
-- migration-upgrade.int.spec.ts) has no provenance table at all and needs its
-- own forward repair; this migration must not turn that into a failed deploy
-- first. Every real environment has the table.
--
-- Rehearsal-only down:
-- ALTER TABLE place_field_provenance DROP COLUMN collected_at;
DO $$
BEGIN
  IF to_regclass('public.place_field_provenance') IS NOT NULL THEN
    ALTER TABLE place_field_provenance ADD COLUMN IF NOT EXISTS collected_at timestamptz;
  END IF;
END
$$;
