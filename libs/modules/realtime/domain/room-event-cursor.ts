/**
 * ADR-0027 — the resume cursor a client sees as the SSE `id` and sends back as
 * `Last-Event-ID`. Clients treat it as opaque; only this module reads it.
 *
 * Format `v2:<generation>:<decimal-seq>`. The generation is part of the
 * identity: after a reset the same `seq` names a different event, so a cursor
 * from the old generation must be answered with `resync`, never compared.
 */
export type EventCursor = { generation: string; seq: number };

/** What the client asked to resume from. */
export type ResumePoint =
  /** No cursor: subscribe-only, replays nothing (the client fetches state). */
  | { kind: 'fresh' }
  | { kind: 'cursor'; cursor: EventCursor }
  /** Malformed, or a pre-ADR-0027 bare sequence number. Answered with `resync`. */
  | { kind: 'invalid' };

const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** No sign, no leading zero, no exponent: one spelling per position. */
const CURSOR = /^v2:([0-9a-f-]{36}):(0|[1-9][0-9]{0,15})$/;

export function isGeneration(value: unknown): value is string {
  return typeof value === 'string' && GENERATION.test(value);
}

export function formatCursor(cursor: EventCursor): string {
  return `v2:${cursor.generation}:${cursor.seq}`;
}

export function parseResumePoint(value: string | null | undefined): ResumePoint {
  // An empty Last-Event-ID is what EventSource sends when it has none.
  if (value === null || value === undefined || value === '') return { kind: 'fresh' };
  const match = CURSOR.exec(value);
  if (!match || !isGeneration(match[1])) return { kind: 'invalid' };
  const seq = Number(match[2]);
  if (!Number.isSafeInteger(seq)) return { kind: 'invalid' };
  return { kind: 'cursor', cursor: { generation: match[1], seq } };
}
