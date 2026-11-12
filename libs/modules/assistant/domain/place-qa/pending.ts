import { z } from 'zod';
import { normalizeVietnamese } from '../../../search/domain/normalize';
import {
  PLACE_QA_CONFIG_VERSION,
  PLACE_QA_PENDING_TTL_MS,
  PLACE_QA_SEMANTIC_VERSION,
} from './config';
import { ANSWER_TOPICS, answerToken, type AnswerTopic } from './tokens';
import type { QaArgs } from './classifier';
const uuid = z.string().uuid();
const args = z
  .object({
    day: z.enum(['weekday', 'date']).optional(),
    d: z.number().int().min(0).max(6).optional(),
    date: z.string().optional(),
    tz: z.literal('Asia/Ho_Chi_Minh').optional(),
    k: z.string().max(64).optional(),
    s: z.string().max(64).optional(),
    n: z.number().int().min(1).max(99).optional(),
  })
  .strict();
const schema = z
  .object({
    v: z.literal(1),
    kind: z.enum(['choice', 'confirm', 'narrow', 'referent']),
    questionMessageId: uuid,
    assistantMessageId: uuid,
    configVersion: z.literal(PLACE_QA_CONFIG_VERSION),
    semanticVersion: z.literal(PLACE_QA_SEMANTIC_VERSION),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    retryCount: z.number().int().min(0).max(1),
    topic: z.enum(ANSWER_TOPICS),
    args,
    slots: z
      .array(
        z
          .object({
            slot: z.literal(0),
            sourceMessageId: uuid,
            resolvedPlaceId: uuid.optional(),
            candidateIds: z.array(uuid).max(3).optional(),
          })
          .strict(),
      )
      .length(1),
    activeSlot: z.literal(0),
    options: z
      .array(
        z
          .object({
            optionId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
            key: z.enum(['place', 'none']),
            slot: z.literal(0),
            placeId: uuid.optional(),
          })
          .strict(),
      )
      .max(4),
  })
  .strict();
/** `questionMessageId` is the message whose question (topic, arguments) is being
 * answered. `slots[0].sourceMessageId` is the message the place NAME is read from
 * (shape rev3 §4.5). They differ only after a referent clarification, where the
 * name arrives in a later reply. Both are server-authored references: the reader
 * of this state re-validates each against the user and conversation before use.
 */
export type QaPending = Omit<z.infer<typeof schema>, 'args'> & { args: QaArgs };
export function readQaPending(
  value: unknown,
  assistantMessageId: string,
  now: number,
): QaPending | null {
  const r = schema.safeParse(value);
  if (!r.success) return null;
  const p = r.data;
  const created = Date.parse(p.createdAt),
    expires = Date.parse(p.expiresAt);
  if (
    p.assistantMessageId !== assistantMessageId ||
    created > now ||
    expires <= now ||
    expires - created !== PLACE_QA_PENDING_TTL_MS
  )
    return null;
  const candidates = p.slots[0]!.candidateIds ?? [];
  if (
    new Set(candidates).size !== candidates.length ||
    new Set(p.options.map((o) => o.optionId)).size !== p.options.length ||
    p.options.some((o) =>
      o.key === 'place' ? !o.placeId || !candidates.includes(o.placeId) : o.placeId !== undefined,
    )
  )
    return null;
  try {
    answerToken({
      ...(p.args as QaArgs),
      topic: p.topic,
      placeId: p.questionMessageId,
      locale: 'vi',
    });
  } catch {
    return null;
  }
  return p as QaPending;
}
export function makeQaPending(input: {
  kind: QaPending['kind'];
  questionMessageId: string;
  /** Name-bearing message; defaults to the question itself. */
  sourceMessageId?: string | undefined;
  assistantMessageId: string;
  now: number;
  topic: AnswerTopic;
  args: QaArgs;
  candidates?: readonly string[];
  retryCount?: number;
}): QaPending {
  const candidates = [...(input.candidates ?? [])];
  return {
    v: 1,
    kind: input.kind,
    questionMessageId: input.questionMessageId,
    assistantMessageId: input.assistantMessageId,
    configVersion: PLACE_QA_CONFIG_VERSION,
    semanticVersion: PLACE_QA_SEMANTIC_VERSION,
    createdAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + PLACE_QA_PENDING_TTL_MS).toISOString(),
    retryCount: input.retryCount ?? 0,
    topic: input.topic,
    args: input.args,
    slots: [
      {
        slot: 0,
        sourceMessageId: input.sourceMessageId ?? input.questionMessageId,
        candidateIds: candidates,
      },
    ],
    activeSlot: 0,
    options: [
      ...candidates.map((placeId, i) => ({
        optionId: `pick_${i + 1}`,
        key: 'place' as const,
        slot: 0 as const,
        placeId,
      })),
      ...(candidates.length ? [{ optionId: 'none', key: 'none' as const, slot: 0 as const }] : []),
    ],
  };
}

/**
 * GoGo-BE#873 round 2 (Sol F-01 / Astra F-03). The text a text-only client sends
 * back for a one-candidate confirmation names the candidate and carries a code
 * bound to THAT confirmation message and place, so a chip of an earlier message
 * (a bare ordinal, or the confirm text of another message or branch) can never
 * confirm this one. Derived, never stored; six digits of FNV-1a over both ids,
 * so an unrelated confirm text matches with probability 1e-6.
 */
export function confirmCode(assistantMessageId: string, placeId: string): string {
  let h = 0x811c9dc5;
  for (const ch of `${assistantMessageId}:${placeId}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return String(h % 1_000_000).padStart(6, '0');
}
export function confirmText(
  locale: 'vi' | 'en',
  name: string,
  assistantMessageId: string,
  placeId: string,
): string {
  // Option text is at most 200 characters (OpenAPI); the code is what binds.
  return `${locale === 'en' ? 'Confirm' : 'Xác nhận'} ${name.slice(0, 160)} (${confirmCode(assistantMessageId, placeId)})`;
}
/** The code of a typed confirm text (already folded), or null when it has none. */
export function typedConfirmCode(folded: string): string | null {
  return /^(?:xac nhan|confirm) .*\((\d{6})\)$/u.exec(folded)?.[1] ?? null;
}
/** Raw user text that is an emitted confirm text, whatever words its name holds. */
export function isTypedConfirm(text: string): boolean {
  return (
    typedConfirmCode(
      normalizeVietnamese(text)
        .replace(/[.!?]+$/u, '')
        .trim(),
    ) !== null
  );
}
