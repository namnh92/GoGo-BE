import { Inject, Injectable, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import type { Actor } from '../../identity/domain/actor';
import {
  isTerminalFrame,
  type AssistantCardRef,
  type AssistantFrame,
} from '../domain/assistant.types';
import { AssistantRepository, type MessageRow } from '../infrastructure/assistant.repository';
import {
  ASSISTANT_FRAME_BUFFER,
  contiguousAfter,
  type AssistantFrameBuffer,
} from '../infrastructure/frame-buffer';
import { AssistantCardHydrator } from './card-hydrator.service';
import { renderPlaceText } from './place-text';
import { requireUser } from './assistant-conversations.service';

export type SseMessage = { id?: string; type: string; data: string } | { comment: string };

export const KEEP_ALIVE_INTERVAL_MS = 20_000;
export const MAX_STREAMS_PER_ACTOR = 5;
/** How often a live reader re-reads the row while the buffer is quiet. */
const ROW_RECHECK_MS = 2_000;
const WAIT_MS = 1_000;

/** `Last-Event-ID` is the frame `seq`; anything else replays from the start. */
export function parseLastEventId(value: string | null | undefined): number {
  if (!value || !/^\d{1,9}$/.test(value)) return 0;
  return Number(value);
}

/**
 * A finished reply whose frames were never folded in (its process died):
 * the stored message as frames, so a replay still ends with a terminal frame.
 */
export function synthesizeFrames(row: MessageRow): AssistantFrame[] {
  const frames: AssistantFrame[] = [];
  let seq = 0;
  const id = row.id;
  if (row.text) frames.push({ type: 'delta', seq: ++seq, messageId: id, text: row.text });
  for (const card of row.cards ?? [])
    frames.push({ type: 'card', seq: ++seq, messageId: id, card });
  if (row.follow_ups?.length)
    frames.push({ type: 'follow_ups', seq: ++seq, messageId: id, groups: row.follow_ups });
  if (row.notice) frames.push({ type: 'notice', seq: ++seq, messageId: id, notice: row.notice });
  if (row.status === 'failed' || row.error) {
    frames.push({
      type: 'error',
      seq: seq + 1,
      messageId: id,
      error: row.error ?? {
        code: 'ASSISTANT_INTERRUPTED',
        message: 'The reply was interrupted',
        field_errors: [],
        request_id: null,
        retryable: true,
      },
    });
  } else {
    frames.push({
      type: 'done',
      seq: seq + 1,
      messageId: id,
      status: row.status === 'streaming' ? 'stopped' : row.status,
    });
  }
  return frames;
}

/**
 * GoGo-BE#713 — `GET …/messages/{messageId}/stream`. A reader of the buffer
 * and of the row, never a trigger: attaching, resuming or attaching ten times
 * runs no inference. Card frames carry ids; this reader hydrates their facts
 * from verified data as it sends them.
 */
@Injectable()
export class AssistantStreamService {
  private readonly streamsPerActor = new Map<string, number>();

  constructor(
    private readonly repo: AssistantRepository,
    private readonly hydrator: AssistantCardHydrator,
    @Inject(ASSISTANT_FRAME_BUFFER) private readonly buffer: AssistantFrameBuffer,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  async stream(
    actor: Actor,
    conversationId: string,
    messageId: string,
    lastEventId: string | null,
    signal?: AbortSignal,
  ): Promise<Observable<SseMessage>> {
    const userId = requireUser(actor);
    // Taken before the first await, like the room stream (GoGo-BE#685): a
    // refusal must reject ahead of the SSE headers.
    const open = this.streamsPerActor.get(actor.id) ?? 0;
    if (open >= MAX_STREAMS_PER_ACTOR) {
      this.metrics.increment('assistant_stream_refusals_total', { reason: 'actor_cap' });
      throw AppError.tooManyRequests('Too many open assistant streams for this session');
    }
    this.streamsPerActor.set(actor.id, open + 1);
    let slotHeld = true;
    const releaseSlot = () => {
      if (!slotHeld) return;
      slotHeld = false;
      signal?.removeEventListener('abort', releaseSlot);
      const remaining = (this.streamsPerActor.get(actor.id) ?? 1) - 1;
      if (remaining <= 0) this.streamsPerActor.delete(actor.id);
      else this.streamsPerActor.set(actor.id, remaining);
    };
    if (signal?.aborted) releaseSlot();
    else signal?.addEventListener('abort', releaseSlot, { once: true });

    let row: MessageRow | null;
    try {
      row = await this.repo.findMessage(userId, conversationId, messageId);
    } catch (err) {
      releaseSlot();
      throw err;
    }
    if (!row || row.role !== 'assistant') {
      releaseSlot();
      throw AppError.notFound();
    }
    const first = row;
    let after = parseLastEventId(lastEventId);

    return new Observable<SseMessage>((subscriber) => {
      let closed = false;
      const keepAlive = setInterval(() => {
        if (!closed) subscriber.next({ comment: 'ping' });
      }, KEEP_ALIVE_INTERVAL_MS);
      keepAlive.unref?.();
      const release = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        releaseSlot();
      };
      const locale = first.locale ?? 'vi';
      const send = async (frame: AssistantFrame) => {
        // Cards are hydrated and place tokens rendered on the way out
        // (A-R-04): neither the buffer nor the row holds a place's facts.
        const body =
          frame.type === 'card'
            ? { ...frame, card: await this.hydrateCard(actor, frame.card as AssistantCardRef) }
            : frame.type === 'delta'
              ? { ...frame, text: await renderPlaceText(this.repo.db, frame.text, locale) }
              : frame;
        if (!closed)
          subscriber.next({ id: String(frame.seq), type: frame.type, data: JSON.stringify(body) });
        after = frame.seq;
      };
      const replayRow = async (r: MessageRow) => {
        const frames = r.frames && r.frames.length > 0 ? r.frames : synthesizeFrames(r);
        for (const f of frames) if (f.seq > after) await send(f);
      };

      void (async () => {
        if (first.status !== 'streaming') {
          await replayRow(first);
          return;
        }
        let lastRowCheck = Date.now();
        while (!closed) {
          const frames = contiguousAfter(await this.buffer.read(messageId, after), after);
          for (const f of frames) {
            await send(f);
            if (isTerminalFrame(f)) return;
          }
          if (Date.now() - lastRowCheck >= ROW_RECHECK_MS) {
            lastRowCheck = Date.now();
            const now = await this.repo.findMessage(userId, conversationId, messageId);
            if (!now) return; // deleted
            if (now.status !== 'streaming') {
              // Finalized; anything the buffer did not deliver comes from the row.
              // A hole the buffer kept is filled here from the complete row.
              const tail = contiguousAfter(await this.buffer.read(messageId, after), after);
              for (const f of tail) await send(f);
              if (!tail.some(isTerminalFrame)) await replayRow(now);
              return;
            }
          }
          await this.buffer.wait(messageId, WAIT_MS);
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          // Completing, not erroring: an error after the headers would become a
          // numbered frame a browser EventSource adopts as its resume point.
          if (!closed) {
            release();
            subscriber.complete();
          }
        });

      return release;
    });
  }

  private async hydrateCard(actor: Actor, ref: AssistantCardRef) {
    const [card] = await this.hydrator.hydrate(actor, [ref]);
    return card;
  }
}
