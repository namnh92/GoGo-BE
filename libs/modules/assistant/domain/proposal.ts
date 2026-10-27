import { z } from 'zod';
import type { AssistantProposalKind, AssistantProposalValue } from './assistant.types';

/**
 * GoGo-BE#713 — a consequential action the assistant prepared and the user
 * has not performed. State machine: `pending → confirmed | dismissed |
 * expired`, with an internal `confirming` while one confirm is in flight
 * (it reads as `pending`). Only `confirmAssistantProposal` moves a proposal to
 * `confirmed`, and only after the target use case wrote with the user as actor.
 */

export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

export type AssistantProposalStatusDb =
  'pending' | 'confirming' | 'confirmed' | 'dismissed' | 'expired';

export type PublicProposalStatus = 'pending' | 'confirmed' | 'dismissed' | 'expired';

/** What a reader sees: `confirming` is pending, a lapsed pending one expired. */
export function publicProposalStatus(
  status: AssistantProposalStatusDb,
  expiresAt: Date,
  now: Date,
): PublicProposalStatus {
  if (status === 'confirmed' || status === 'dismissed' || status === 'expired') return status;
  return expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
}

/** Per kind: which fields exist, which the card may edit, and their schema. */
type FieldSpec = { editable: boolean; schema: z.ZodTypeAny };

const uuid = z.string().uuid();
const iso = z
  .string()
  .datetime({ offset: true })
  .refine((v) => !Number.isNaN(Date.parse(v)), 'expected an ISO-8601 instant');
const areaSchema = z
  .object({
    datasetVersion: z.string().trim().min(1).max(200),
    provinceCode: z.string().regex(/^\d{2,5}$/),
    communeCode: z
      .string()
      .regex(/^\d{2,5}$/)
      .nullable(),
  })
  .strict();

export const PROPOSAL_FIELDS: Record<AssistantProposalKind, Record<string, FieldSpec>> = {
  create_room: {
    type: { editable: true, schema: z.enum(['couple', 'group']) },
    participantCount: { editable: true, schema: z.number().int().min(2).max(20) },
    decisionMode: { editable: true, schema: z.enum(['match', 'vote', 'host']) },
    title: { editable: true, schema: z.string().trim().min(1).max(80) },
    startAt: { editable: true, schema: iso },
    endAt: { editable: true, schema: iso },
    budgetMode: { editable: true, schema: z.enum(['total', 'per_person']) },
    budgetAmount: { editable: true, schema: z.number().int().min(0).max(1_000_000_000_000) },
    administrativeArea: { editable: true, schema: areaSchema },
    seedPlaceIds: { editable: true, schema: z.array(uuid).max(10) },
  },
  create_invite: {
    roomId: { editable: false, schema: uuid },
    maxUses: { editable: true, schema: z.number().int().min(1).max(50) },
  },
  cast_vote: {
    roomId: { editable: false, schema: uuid },
    placeId: { editable: false, schema: uuid },
    value: { editable: true, schema: z.enum(['yes', 'no', 'star']) },
  },
  finalize_plan: {
    roomId: { editable: false, schema: uuid },
    placeId: { editable: true, schema: uuid },
  },
};

export type FieldErrorOut = { field: string; code: string; message: string };

/** Validates the values a proposal is created with; a bad one is never shown. */
export function validateProposalValues(
  kind: AssistantProposalKind,
  values: readonly AssistantProposalValue[],
): FieldErrorOut[] {
  const specs = PROPOSAL_FIELDS[kind];
  const errors: FieldErrorOut[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const spec = Object.hasOwn(specs, v.field) ? specs[v.field] : undefined;
    if (!spec) {
      errors.push({ field: v.field, code: 'unknown_field', message: 'not a field of this action' });
      continue;
    }
    if (seen.has(v.field)) {
      errors.push({ field: v.field, code: 'duplicate', message: 'field listed twice' });
    }
    seen.add(v.field);
    const parsed = spec.schema.safeParse(v.value);
    if (!parsed.success) {
      errors.push({ field: v.field, code: 'invalid', message: parsed.error.issues[0]!.message });
    }
  }
  return errors;
}

/**
 * The user's edits from the card. Each listed field must exist and be editable
 * for the kind; it becomes `explicit`. Unlisted fields keep the proposed value.
 */
export function mergeEditedValues(
  kind: AssistantProposalKind,
  values: readonly AssistantProposalValue[],
  edits: Record<string, unknown> | undefined,
): { values: AssistantProposalValue[]; errors: FieldErrorOut[] } {
  const specs = PROPOSAL_FIELDS[kind];
  const errors: FieldErrorOut[] = [];
  const out = values.map((v) => ({ ...v }));
  for (const [field, value] of Object.entries(edits ?? {})) {
    const spec = Object.hasOwn(specs, field) ? specs[field] : undefined;
    if (!spec) {
      errors.push({ field, code: 'unknown_field', message: 'not a field of this action' });
      continue;
    }
    if (!spec.editable) {
      errors.push({ field, code: 'not_editable', message: 'this field cannot be changed' });
      continue;
    }
    const parsed = spec.schema.safeParse(value);
    if (!parsed.success) {
      errors.push({ field, code: 'invalid', message: parsed.error.issues[0]!.message });
      continue;
    }
    const existing = out.find((v) => v.field === field);
    if (existing) {
      existing.value = parsed.data;
      existing.origin = 'explicit';
    } else {
      out.push({ field, value: parsed.data, origin: 'explicit', editable: true });
    }
  }
  return { values: out, errors };
}

export function valueOf<T = unknown>(
  values: readonly AssistantProposalValue[],
  field: string,
): T | undefined {
  return values.find((v) => v.field === field)?.value as T | undefined;
}
