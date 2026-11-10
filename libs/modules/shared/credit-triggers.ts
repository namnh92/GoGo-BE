import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './app-error';
import type { CreditCondition, CreditScope } from './credit-catalogue';

const owner = z.enum(['sync', 'evaluator', 'none']);
const recipient = z.string().uuid().nullish();
const count = z.number().int().nonnegative();
const decision = z.enum(['approved', 'merged', 'rejected']);
const common = { grantOwner: owner };
const submission = z.object({
  ...common,
  submissionId: z.string().uuid(),
  venueIdentity: z.string().startsWith('google:'),
  decision,
  recipientUserId: recipient,
  approvedEvidenceCount: count,
  placeId: z.string().uuid().optional(),
  reviewId: z.string().uuid().optional(),
  existingPlaceId: z.string().uuid().optional(),
  rejectionReason: z.string().max(64).optional(),
  updateDeadline: z.string().datetime().optional(),
});
const review = z
  .object({
    ...common,
    reviewId: z.string().uuid(),
    userId: recipient,
    target: z.enum(['place', 'plan']),
    placeId: z.string().uuid().optional(),
    firstPublication: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.target === 'place' && !v.placeId)
      ctx.addIssue({ code: 'custom', message: 'placeId required' });
  });
const room = z.object({
  ...common,
  roomId: z.string().uuid(),
  triggeredAt: z.string().datetime(),
  room: z.object({ type: z.enum(['couple', 'group']), participantCount: count }),
  plan: z.object({ stopsCompleted: count }),
  subjects: z.array(
    z.object({
      userId: z.string().uuid(),
      memberId: z.string().uuid(),
      role: z.enum(['host', 'member']),
    }),
  ),
});
export type CreditFacts = Record<string, unknown>;
export type CanonicalCreditEvent = {
  facts: CreditFacts;
  userIds: string[];
  sourceType: 'submission' | 'review' | 'room';
  sourceId: string;
};
export type CreditTrigger = {
  schemaVersion: number;
  supportedAudiences: readonly ('individual' | 'group')[];
  supportedScopes: readonly CreditScope[];
  facts: readonly string[];
  decoders: Record<number, ((payload: unknown) => CanonicalCreditEvent) | 'historical'>;
};
const individualScopes: readonly CreditScope[] = ['per_source', 'per_subject', 'per_occurrence'];
const decodeSubmission =
  (evidence: boolean) =>
  (payload: unknown): CanonicalCreditEvent => {
    const v = (
      evidence
        ? submission
        : submission.extend({ googlePlaceId: z.string().min(1), variant: z.string().min(1) })
    ).parse(payload);
    if (evidence && (v.approvedEvidenceCount < 1 || v.decision === 'rejected'))
      throw new Error('Invalid evidence facts');
    return {
      facts: v,
      userIds: v.recipientUserId ? [v.recipientUserId] : [],
      sourceType: 'submission',
      sourceId: v.submissionId,
    };
  };
export const CREDIT_TRIGGERS: Record<string, CreditTrigger> = {
  'place.submission_decided': {
    schemaVersion: 2,
    supportedAudiences: ['individual'],
    supportedScopes: ['per_venue', ...individualScopes],
    facts: [
      'submissionId',
      'googlePlaceId',
      'venueIdentity',
      'decision',
      'variant',
      'approvedEvidenceCount',
      'placeId',
      'reviewId',
      'updateDeadline',
      'existingPlaceId',
      'rejectionReason',
      'subject.key',
    ],
    decoders: { 1: 'historical', 2: decodeSubmission(false) },
  },
  'place.submission_evidence_approved': {
    schemaVersion: 2,
    supportedAudiences: ['individual'],
    supportedScopes: individualScopes,
    facts: ['submissionId', 'venueIdentity', 'decision', 'approvedEvidenceCount', 'subject.key'],
    decoders: { 2: decodeSubmission(true) },
  },
  'review.published': {
    schemaVersion: 2,
    supportedAudiences: ['individual'],
    supportedScopes: ['per_place_subject', ...individualScopes],
    facts: ['reviewId', 'target', 'placeId', 'firstPublication', 'subject.key'],
    decoders: {
      2: (payload) => {
        const v = review.parse(payload);
        return {
          facts: v,
          userIds: v.userId ? [v.userId] : [],
          sourceType: 'review',
          sourceId: v.reviewId,
        };
      },
    },
  },
  'room.completed': {
    schemaVersion: 2,
    supportedAudiences: ['group'],
    supportedScopes: ['per_source', 'per_occurrence'],
    facts: [
      'roomId',
      'triggeredAt',
      'room.type',
      'room.participantCount',
      'plan.stopsCompleted',
      'subject.key',
    ],
    decoders: {
      2: (payload) => {
        const v = room.parse(payload);
        return {
          facts: v,
          userIds: [...new Set(v.subjects.map((s) => s.userId))].sort(),
          sourceType: 'room',
          sourceId: v.roomId,
        };
      },
    },
  },
};
for (const name of [
  'plan.published',
  'plan.changed',
  'stop.completed',
  'vote.cast',
  'room.status_active',
  'member.joined',
  'preferences.completed',
]) {
  CREDIT_TRIGGERS[name] = {
    schemaVersion: 1,
    supportedAudiences: [],
    supportedScopes: [],
    facts: [],
    decoders: {},
  };
}
export const CREDIT_EVENT_TYPES = Object.keys(CREDIT_TRIGGERS).filter(
  (k) => CREDIT_TRIGGERS[k]!.supportedAudiences.length,
);

export function creditSubjectKey(secret: string, userId: string): string {
  if (secret.length < 32)
    throw new Error('CREDITS_SUBJECT_KEY_SECRET must have at least 32 characters');
  return createHmac('sha256', secret).update(userId).digest('hex').slice(0, 32);
}
export function validateCreditRule(
  triggerType: string,
  audience: string,
  scope: CreditScope,
  condition: unknown,
): asserts condition is CreditCondition {
  const trigger = CREDIT_TRIGGERS[triggerType];
  if (!trigger || !trigger.supportedAudiences.some((a) => a === audience))
    throw AppError.badRequest('TRIGGER_AUDIENCE_UNSUPPORTED', 'Unsupported credit audience');
  if (!trigger.supportedScopes.includes(scope))
    throw AppError.badRequest('DEDUP_SCOPE_UNSUPPORTED', 'Unsupported credit scope');
  let leaves = 0;
  const invalid = () => {
    throw AppError.badRequest('CONDITION_INVALID', 'Invalid credit condition');
  };
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return invalid();
    const n = node as Record<string, unknown>;
    if ('all' in n || 'any' in n) {
      const children = n.all ?? n.any;
      if (depth > 1 || Object.keys(n).length !== 1 || !Array.isArray(children)) return invalid();
      for (const child of children) visit(child, depth + 1);
    } else {
      if (
        ++leaves > 10 ||
        !trigger.facts.includes(String(n.fact)) ||
        !['eq', 'neq', 'in', 'gte', 'lte', 'exists'].includes(String(n.op)) ||
        Object.keys(n).some((k) => !['fact', 'op', 'value'].includes(k))
      )
        return invalid();
      if (n.op === 'in' && (!Array.isArray(n.value) || n.value.length > 100)) return invalid();
      if (
        (n.op === 'gte' || n.op === 'lte') &&
        (typeof n.value !== 'number' || !Number.isFinite(n.value))
      )
        return invalid();
      if (n.op === 'exists' && typeof n.value !== 'boolean') return invalid();
      if (
        (n.op === 'eq' || n.op === 'neq') &&
        !['string', 'number', 'boolean'].includes(typeof n.value) &&
        n.value !== null
      )
        return invalid();
    }
  };
  visit(condition, 0);
}
function factAt(facts: CreditFacts, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === 'object' && Object.hasOwn(v, k) ? (v as CreditFacts)[k] : undefined,
      facts,
    );
}
export function matchesCreditCondition(condition: CreditCondition, facts: CreditFacts): boolean {
  if ('all' in condition) return condition.all.every((c) => matchesCreditCondition(c, facts));
  if ('any' in condition) return condition.any.some((c) => matchesCreditCondition(c, facts));
  const value = factAt(facts, condition.fact);
  switch (condition.op) {
    case 'eq':
      return value === condition.value;
    case 'neq':
      return value !== condition.value;
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(value);
    case 'exists':
      return (value !== undefined && value !== null) === condition.value;
    case 'gte':
      return typeof value === 'number' && value >= Number(condition.value);
    case 'lte':
      return typeof value === 'number' && value <= Number(condition.value);
  }
}
export function creditEntitlementKey(
  scope: CreditScope,
  event: CanonicalCreditEvent,
  outboxId: string,
  subjectKey: string,
  audience: 'individual' | 'group',
): string {
  switch (scope) {
    case 'per_venue':
      if (typeof event.facts.venueIdentity !== 'string') throw new Error('Missing venue identity');
      return `venue:${event.facts.venueIdentity}`;
    case 'per_source':
      return `${event.sourceType}:${event.sourceId}${audience === 'group' ? `:${subjectKey}` : ''}`;
    case 'per_place_subject':
      if (typeof event.facts.placeId !== 'string') throw new Error('Missing place identity');
      return `place:${event.facts.placeId}:${subjectKey}`;
    case 'per_subject':
      return `subj:${subjectKey}`;
    case 'per_occurrence':
      return `evt:${outboxId}:${subjectKey}`;
  }
}
