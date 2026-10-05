import { sql } from 'drizzle-orm';
import {
  CONTACT_API_FIELD,
  CONTACT_FIELDS,
  normalizeAddress,
  normalizePhone,
  normalizeWebsite,
  validateEvidence,
  type ContactEvidence,
  type ContactEvidenceInput,
  type ContactField,
  type ContactIssue,
} from './place-contact';

/**
 * GoGo-BE#280 — what one write does to the three GoGo-owned contact fields.
 *
 * Shared by the console's create and edit and by submission approval, so the
 * rule is stated once: a value is GoGo's only when it arrives with independent
 * evidence; `null` clears without inventing any; an absent key leaves the field
 * alone.
 *
 * Pure: no database, no clock beyond the `now` it is handed. The caller writes
 * the plan inside its own transaction.
 */

type ApiField = (typeof CONTACT_API_FIELD)[ContactField];

export type ContactWriteInput = {
  addressText?: string | null | undefined;
  phone?: string | null | undefined;
  website?: string | null | undefined;
  provenance?: Partial<Record<ApiField, ContactEvidenceInput | null | undefined>> | undefined;
};

export type ContactCurrent = {
  addressText: string | null;
  phone: string | null;
  website: string | null;
};

export type ContactWritePlan = {
  /** Column values to set, keyed by the API name. Absent = untouched. */
  values: Partial<Record<ApiField, string | null>>;
  /** Fields written with evidence, which their provenance row records. */
  claims: { field: ContactField; evidence: ContactEvidence }[];
  /** Fields set to null; their provenance row is removed with the value. */
  cleared: ContactField[];
};

const NORMALIZE: Record<
  ContactField,
  (raw: string) => { ok: true; value: string } | { ok: false; issue: ContactIssue }
> = {
  address_text: normalizeAddress,
  phone: normalizePhone,
  website: normalizeWebsite,
};

/**
 * `current` is the stored row for an edit, `null` for a create. With a stored
 * row, a supplied value equal to what is already there and carrying no
 * evidence is not a write at all: a console that re-sends the whole form must
 * not be told to re-prove a value nobody changed, and must not advance its
 * `verifiedAt` either. The same value *with* evidence is a re-verification and
 * is written.
 */
export function planContactWrite(
  input: ContactWriteInput,
  current: ContactCurrent | null,
  now: Date = new Date(),
): { ok: true; plan: ContactWritePlan } | { ok: false; issues: ContactIssue[] } {
  const issues: ContactIssue[] = [];
  const plan: ContactWritePlan = { values: {}, claims: [], cleared: [] };

  for (const field of CONTACT_FIELDS) {
    const api = CONTACT_API_FIELD[field];
    const value = input[api];
    const evidence = input.provenance?.[api];
    const evidencePath = `provenance.${api}`;
    const hasEvidence = evidence !== undefined && evidence !== null;

    if (value === undefined) {
      if (hasEvidence) {
        issues.push({
          field: evidencePath,
          code: 'value_missing',
          message: 'Có nguồn nhưng không có giá trị đi kèm',
        });
      }
      continue;
    }

    if (value === null) {
      if (hasEvidence) {
        issues.push({
          field: evidencePath,
          code: 'not_allowed',
          message: 'Xoá giá trị không kèm nguồn',
        });
        continue;
      }
      // Clearing what is already empty is not a write.
      if (current === null || current[api] === null) continue;
      plan.values[api] = null;
      plan.cleared.push(field);
      continue;
    }

    // DEV-F-11 — the exact stored string, re-sent without evidence, is no
    // write at all. Checked before normalizing: a legacy value written before
    // today's rules may not pass them, and a whole-form save that never
    // touched it must not be refused for it.
    if (!hasEvidence && current !== null && current[api] === value) continue;

    const normalized = NORMALIZE[field](value);
    if (!normalized.ok) {
      issues.push({ ...normalized.issue, field: api });
      continue;
    }
    if (!hasEvidence && current !== null && current[api] === normalized.value) continue;
    if (!hasEvidence) {
      issues.push({
        field: evidencePath,
        code: 'required',
        message: 'Giá trị này cần nguồn độc lập: loại nguồn, tham chiếu và thời điểm thu thập',
      });
      continue;
    }
    const checked = validateEvidence(
      evidence,
      {
        sourceType: `${evidencePath}.sourceType`,
        sourceReference: `${evidencePath}.sourceReference`,
        collectedAt: `${evidencePath}.collectedAt`,
      },
      now,
    );
    if (!checked.ok) {
      issues.push(...checked.issues);
      continue;
    }
    plan.values[api] = normalized.value;
    plan.claims.push({ field, evidence: checked.value });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plan };
}

export function planIsEmpty(plan: ContactWritePlan): boolean {
  return Object.keys(plan.values).length === 0;
}

/**
 * SA-F-11 — declares the current transaction a GoGo-BE#280 contact writer, so
 * the `places_guard_evidenced_contacts` trigger (migration 0070) lets it change
 * an evidenced `address_text` / `phone` / `website`. Transaction-local: it ends
 * with the transaction, and a writer from the release before #280 never sets
 * it — which is what keeps evidence honest across an application rollback.
 * Call it inside the transaction that also rewrites or removes the evidence.
 */
export async function declareContactWriter(tx: {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  await tx.execute(sql`select set_config('gogo.contact_write', 'on', true)`);
}
