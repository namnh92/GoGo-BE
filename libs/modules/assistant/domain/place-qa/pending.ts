import type { PlaceFacts } from './place-facts';
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

/** Owner 2026-11-12: identity is the complete name + current area, never a code.
 * Missing/oversized identity has no safe text confirmation; use an ordinal to
 * re-ask instead. The service checks uniqueness against the complete catalogue.
 */
export function confirmText(
  locale: 'vi' | 'en',
  name: string,
  area: string | undefined,
  discriminator?: string,
): string | null {
  if (!name.trim() || !area?.trim()) return null;
  const text = `${locale === 'en' ? 'Confirm' : 'Xác nhận'} ${name} · ${area}${discriminator ? ` · ${discriminator}` : ''}`;
  return text.length <= 200 && !/[\uE000\uE001]/u.test(text) ? text : null;
}
export function isTypedConfirm(text: string): boolean {
  return /^(?:xac nhan|confirm) .+(?: · .+| \(\d{6}\))$/u.test(
    normalizeVietnamese(text)
      .replace(/[.!?]+$/u, '')
      .trim(),
  );
}

/** Compare complete normalized identities, never guess a branch from an ordinal.
 * Only existing public identity facts may discriminate; no synthetic codes. */
export function choiceDiscriminator(
  place: PlaceFacts,
  candidates: readonly PlaceFacts[],
  scope: 'choice' | 'confirm' = 'confirm',
): string | undefined {
  const peers = candidates.filter(
    (p) =>
      p.available &&
      normalizeVietnamese(p.name) === normalizeVietnamese(place.name) &&
      (scope === 'choice' ||
        normalizeVietnamese(p.areaLabel ?? '') === normalizeVietnamese(place.areaLabel ?? '')),
  );
  if (peers.length < 2 && !place.hasIdentityCollision) return undefined;
  const address = place.card?.facts.addressText?.trim();
  if (address) {
    const parts = address
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    const peerParts = peers
      .filter((p) => p.id !== place.id)
      .map((p) =>
        (p.card?.facts.addressText ?? '')
          .split(',')
          .map((part) => normalizeVietnamese(part.trim())),
      );
    // Prefer house number + street. If shared, use the first distinguishing
    // address component; only combine components when no single part suffices.
    return (
      parts.find((part) =>
        peerParts.every((other) => !other.includes(normalizeVietnamese(part))),
      ) ??
      parts
        .map((_, i) => parts.slice(0, i + 1).join(', '))
        .find((prefix) =>
          peers.every(
            (p) =>
              p.id === place.id ||
              !normalizeVietnamese(p.card?.facts.addressText ?? '').startsWith(
                normalizeVietnamese(prefix),
              ),
          ),
        ) ??
      address
    );
  }
  return (
    place.card?.facts.areaKey?.trim() ||
    (scope === 'choice' ? place.areaLabel?.trim() : undefined) ||
    undefined
  );
}
export function choiceText(place: PlaceFacts, candidates: readonly PlaceFacts[]): string {
  const discriminator = choiceDiscriminator(place, candidates, 'choice');
  const text = `${place.name}${discriminator ? ` · ${discriminator}` : ''}`;
  // Do not truncate an identity into a different branch's name. A full name
  // still fits the contract; if the address cannot fit, typing it must re-ask.
  return text.length <= 200 ? text : place.name;
}

/** OpenAPI maxLength counts Unicode code points, not UTF-16 units. Only the
 * display label is shortened; typed identity and prompt text stay independent.
 * Each option's unique ordinal survives shortening, so two labels cannot collide
 * even if their shortened names and discriminators have identical prefixes. */
export function choiceLabel(ordinal: number, name: string, discriminator?: string): string {
  const prefix = `${ordinal}. `;
  const available = 40 - Array.from(prefix).length;
  if (!discriminator) return prefix + shorten(name, available);
  const nameBudget = Math.max(1, available - 3 - Array.from(discriminator).length);
  const shortName = shorten(name, nameBudget);
  const addressBudget = available - 3 - Array.from(shortName).length;
  return `${prefix}${shortName} · ${shorten(discriminator, addressBudget)}`;
}
function shorten(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max
    ? value
    : `${points
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}
