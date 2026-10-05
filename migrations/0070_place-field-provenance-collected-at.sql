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
--> statement-breakpoint
-- SA-F-11 (Astra, GoGo-BE#280 review) — the ownership guard lives in the one
-- layer an application rollback keeps: the database.
--
-- The release before #280 refreshes `address_text` from Google in
-- `update_existing` unless the field is claimed `editorial`. Rolled back onto
-- data this release wrote, it would overwrite a `community`- or
-- `provider`-evidenced address with Google's and leave the evidence row in
-- place, and rolling forward again would report Google's text as GoGo's.
--
-- So an UPDATE that changes an evidenced contact column (a provenance row with
-- `collected_at`) is refused unless the transaction declared itself a #280
-- contact writer with `set_config('gogo.contact_write', 'on', true)` — which
-- only this release's writers do, inside the transaction that also rewrites
-- or removes the evidence. The old writer's update fails loudly (its import
-- row is marked failed) instead of silently relabelling Google content.
-- Legacy rows without `collected_at` are unaffected, so the old release keeps
-- its old behaviour on old data.
--
-- Rehearsal-only down:
-- DROP TRIGGER places_guard_evidenced_contacts ON places;
-- DROP FUNCTION guard_evidenced_place_contacts();
CREATE OR REPLACE FUNCTION guard_evidenced_place_contacts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('gogo.contact_write', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF (NEW.address_text IS DISTINCT FROM OLD.address_text AND EXISTS (
        SELECT 1 FROM place_field_provenance
        WHERE place_id = OLD.id AND field = 'address_text' AND collected_at IS NOT NULL))
     OR (NEW.phone IS DISTINCT FROM OLD.phone AND EXISTS (
        SELECT 1 FROM place_field_provenance
        WHERE place_id = OLD.id AND field = 'phone' AND collected_at IS NOT NULL))
     OR (NEW.website IS DISTINCT FROM OLD.website AND EXISTS (
        SELECT 1 FROM place_field_provenance
        WHERE place_id = OLD.id AND field = 'website' AND collected_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'GOGO_CONTACT_EVIDENCE_GUARD: place % has evidenced contact fields; only a #280 contact writer may change them', OLD.id
      USING ERRCODE = 'P0280';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS places_guard_evidenced_contacts ON places;
--> statement-breakpoint
CREATE TRIGGER places_guard_evidenced_contacts
  BEFORE UPDATE OF address_text, phone, website ON places
  FOR EACH ROW EXECUTE FUNCTION guard_evidenced_place_contacts();
--> statement-breakpoint
-- SA-F-14 (Astra, second round) — the evidence itself is guarded too. The
-- previous release's console rewrites the provenance of every contact field
-- a whole-form save carries, even unchanged ones, to `editorial` with a NULL
-- reference; the place-column guard cannot see that (the value does not
-- change), and the evidence would be lost. So an UPDATE or DELETE of a
-- contact provenance row that carries #280 evidence (`collected_at`) needs
-- the same transaction-local declaration as the place columns. An
-- `INSERT … ON CONFLICT DO UPDATE` is an UPDATE here.
--
-- A cascade from deleting the place itself is allowed: the row's place no
-- longer exists by the time the cascade reaches it, and there is nothing
-- left to protect.
--
-- Rehearsal-only down:
-- DROP TRIGGER place_field_provenance_guard_evidence ON place_field_provenance;
-- DROP FUNCTION guard_contact_evidence();
CREATE OR REPLACE FUNCTION guard_contact_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.field NOT IN ('address_text', 'phone', 'website') OR OLD.collected_at IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF current_setting('gogo.contact_write', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM places WHERE id = OLD.place_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'GOGO_CONTACT_EVIDENCE_GUARD: evidence for % on place % may only be changed by a #280 contact writer', OLD.field, OLD.place_id
    USING ERRCODE = 'P0280';
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.place_field_provenance') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS place_field_provenance_guard_evidence ON place_field_provenance;
    CREATE TRIGGER place_field_provenance_guard_evidence
      BEFORE UPDATE OR DELETE ON place_field_provenance
      FOR EACH ROW EXECUTE FUNCTION guard_contact_evidence();
  END IF;
END
$$;
