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
import { PlaceAnswerReader, type RenderedPlaceGroup } from './place-answer-reader';
import { isPlaceAnswerRow } from '../domain/place-qa/reference-group';
import { LOAD_ERROR } from '../domain/place-qa/templates';
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
  if (row.text || isPlaceAnswerRow(row))
    frames.push({ type: 'delta', seq: ++seq, messageId: id, text: row.text });
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
    @Optional() private readonly placeAnswers: PlaceAnswerReader = new PlaceAnswerReader(),
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
      const readerAbort = new AbortController();
      const readerCancel = () => readerAbort.abort();
      signal?.addEventListener('abort', readerCancel, { once: true });
      if (signal?.aborted) readerCancel();
      let firstRendered = false;
      const live = first.status === 'streaming' && after === 0;
      let qaSeen = isPlaceAnswerRow(first);
      let routeChecked =
        !qaSeen &&
        (first.trace?.streamRoute === 'ordinary' || typeof first.trace?.route === 'string');
      const deadlineAt = this.placeAnswers.firstVisibleDeadline(Date.parse(first.created_at));
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      // Bound every attachment await, even if the underlying I/O ignores cancellation.
      const readerWork = async <T>(work: () => Promise<T>): Promise<T> => {
        readerAbort.signal.throwIfAborted();
        let cancel!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
          cancel = () => reject(new Error('reader cancelled'));
          readerAbort.signal.addEventListener('abort', cancel, { once: true });
        });
        try {
          return await Promise.race([work(), cancelled]);
        } finally {
          readerAbort.signal.removeEventListener('abort', cancel);
        }
      };
      const keepAlive = setInterval(() => {
        if (!closed) subscriber.next({ comment: 'ping' });
      }, KEEP_ALIVE_INTERVAL_MS);
      keepAlive.unref?.();
      const release = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        clearTimeout(deadlineTimer);
        readerAbort.abort();
        signal?.removeEventListener('abort', readerCancel);
        releaseSlot();
      };
      const locale = first.locale ?? 'vi';
      const failReader = (result: 'timeout' | 'read_error') => {
        if (closed || readerAbort.signal.aborted) return;
        // Unnumbered reader-only response: never skip an unfinished producer's
        // later committed sequence on reconnect.
        subscriber.next({
          type: 'delta',
          data: JSON.stringify({
            type: 'delta',
            seq: after + 1,
            messageId,
            text: LOAD_ERROR[locale],
          }),
        });
        subscriber.next({
          type: 'error',
          data: JSON.stringify({
            type: 'error',
            seq: after + 2,
            messageId,
            error: {
              code: result === 'timeout' ? 'ASSISTANT_RENDER_TIMEOUT' : 'ASSISTANT_RENDER_FAILED',
              message: LOAD_ERROR[locale],
              field_errors: [],
              request_id: null,
              retryable: true,
            },
          }),
        });
        this.metrics.increment('assistant_place_answer_render_total', {
          mode: live ? 'live' : 'replay',
          result,
        });
        if (live && !firstRendered) {
          firstRendered = true;
          clearTimeout(deadlineTimer);
          this.metrics.observe(
            'assistant_place_answer_first_visible_text_seconds',
            (Date.now() - Date.parse(first.created_at)) / 1000,
            { mode: 'live' },
          );
        }
      };

      const armDeadline = () => {
        if (!live || firstRendered || deadlineTimer || (!qaSeen && routeChecked)) return;
        deadlineTimer = setTimeout(
          () => {
            failReader('timeout');
            release();
            subscriber.complete();
          },
          Math.max(0, deadlineAt - Date.now()),
        );
      };
      armDeadline();

      const send = async (frame: AssistantFrame) => {
        // Cards are hydrated and place tokens rendered on the way out
        // (A-R-04): neither the buffer nor the row holds a place's facts.
        const body =
          frame.type === 'card'
            ? { ...frame, card: await this.hydrateCard(actor, frame.card as AssistantCardRef) }
            : frame.type === 'delta'
              ? {
                  ...frame,
                  text: await renderPlaceText(
                    this.repo.db,
                    frame.text,
                    locale,
                    this.metrics,
                    live ? 'live' : 'replay',
                  ),
                }
              : frame;
        if (!closed)
          subscriber.next({ id: String(frame.seq), type: frame.type, data: JSON.stringify(body) });
        after = frame.seq;
      };
      const sendRendered = (frame: AssistantFrame) => {
        if (closed || readerAbort.signal.aborted) return;
        if (live && !firstRendered && Date.now() >= deadlineAt) {
          failReader('timeout');
          release();
          subscriber.complete();
          return;
        }
        subscriber.next({ id: String(frame.seq), type: frame.type, data: JSON.stringify(frame) });
        after = frame.seq;
        if (live && frame.type === 'delta' && frame.text.trim() && !firstRendered) {
          firstRendered = true;
          clearTimeout(deadlineTimer);
          this.metrics.observe(
            'assistant_place_answer_first_visible_text_seconds',
            (Date.now() - Date.parse(first.created_at)) / 1000,
            { mode: 'live' },
          );
        }
      };
      const replayRow = async (r: MessageRow) => {
        let frames = r.frames && r.frames.length > 0 ? r.frames : synthesizeFrames(r);
        const qa = isPlaceAnswerRow(r);
        if (qa) {
          const group = (
            await readerWork(() =>
              this.placeAnswers.page([r], live ? 'live' : 'replay', {
                signal: readerAbort.signal,
                ...(live ? { acceptedAt: Date.parse(first.created_at) } : {}),
              }),
            )
          ).get(r.id)!;
          frames = renderGroupFrames(frames, group, r.locale ?? 'vi');
        }
        let ended = false;
        for (const f of frames) {
          if (f.seq <= after) continue;
          if (qa) sendRendered(f);
          else await send(f);
          if (isTerminalFrame(f)) ended = true;
        }
        // A-R2-09: a writer that lost the turn may have taken the committed
        // terminal frame's seq in the buffer; the reader still ends with the
        // committed outcome, numbered after what it already sent.
        if (qa && frames.some((f) => isTerminalFrame(f) && f.seq <= after)) return;
        if (!ended) {
          const terminal =
            [...frames].reverse().find(isTerminalFrame) ??
            synthesizeFrames(r).find(isTerminalFrame)!;
          if (qa) sendRendered({ ...terminal, seq: after + 1 });
          else await send({ ...terminal, seq: after + 1 });
        }
      };

      void (async () => {
        if (first.status !== 'streaming') {
          await replayRow(first);
          return;
        }
        let lastRowCheck = Date.now();
        while (!closed && !readerAbort.signal.aborted) {
          const frames = contiguousAfter(
            await readerWork(() => this.buffer.read(messageId, after)),
            after,
          );
          // Route can be recorded AFTER this reader attached. Recheck before
          // releasing a buffered group, including cards that precede tokens.
          qaSeen ||= frames.some((f) => f.type === 'delta' && isPlaceAnswerRow({ text: f.text }));
          let current: MessageRow | null = null;
          if ((!routeChecked && frames.length) || qaSeen) {
            current = await readerWork(() =>
              this.repo.findMessage(userId, conversationId, messageId),
            );
            if (!current) return;
            qaSeen ||= isPlaceAnswerRow(current);
            routeChecked = true;
            if (!qaSeen) {
              clearTimeout(deadlineTimer);
              deadlineTimer = undefined;
            }
          }
          qaSeen ||= frames.some((f) => f.type === 'delta' && isPlaceAnswerRow({ text: f.text }));
          // QA is an atomic committed group. Do not hydrate buffered cards or
          // release a prefix before all compare/source references are known.
          if (qaSeen) {
            armDeadline();
            current ??= await readerWork(() =>
              this.repo.findMessage(userId, conversationId, messageId),
            );
            if (!current) return;
            if (current.status !== 'streaming') {
              await replayRow(current);
              return;
            }
            const remaining =
              this.placeAnswers.firstVisibleDeadline(Date.parse(first.created_at)) - Date.now();
            if (live && remaining <= 0) {
              failReader('timeout');
              return;
            }
            await readerWork(() =>
              this.buffer.wait(
                messageId,
                live ? Math.max(1, Math.min(WAIT_MS, remaining)) : WAIT_MS,
              ),
            );
            continue;
          }
          for (const f of frames) {
            await send(f);
            if (isTerminalFrame(f)) return;
          }
          if (Date.now() - lastRowCheck >= ROW_RECHECK_MS) {
            lastRowCheck = Date.now();
            const now = await readerWork(() =>
              this.repo.findMessage(userId, conversationId, messageId),
            );
            if (!now) return; // deleted
            qaSeen ||= isPlaceAnswerRow(now);
            if (qaSeen) armDeadline();
            if (now.status !== 'streaming') {
              // Finalized; anything the buffer did not deliver comes from the row.
              // A hole the buffer kept is filled here from the complete row.
              if (isPlaceAnswerRow(now)) {
                await replayRow(now);
                return;
              }
              const tail = contiguousAfter(
                await readerWork(() => this.buffer.read(messageId, after)),
                after,
              );
              for (const f of tail) await send(f);
              if (!tail.some(isTerminalFrame)) await replayRow(now);
              return;
            }
          }
          await readerWork(() => this.buffer.wait(messageId, WAIT_MS));
        }
      })()
        .catch(() => {
          if (qaSeen) failReader('read_error');
        })
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

/** Sequence ids remain committed ids; reconnect renders the FULL group first,
 * then the caller selects the suffix. No extra fact/card lookup is possible. */
export function renderGroupFrames(
  frames: readonly AssistantFrame[],
  group: RenderedPlaceGroup,
  locale: 'vi' | 'en',
): AssistantFrame[] {
  let textSent = false;
  const failed = group.result === 'read_error' || group.result === 'timeout';
  return frames.flatMap((f): AssistantFrame[] => {
    if (f.type === 'delta') {
      if (textSent) return [];
      textSent = true;
      return [{ ...f, text: group.text }];
    }
    if (f.type === 'card') {
      const ref = f.card as AssistantCardRef;
      const card =
        ref.kind === 'place' ? group.cards.find((c) => c.placeId === ref.placeId) : undefined;
      return card ? [{ ...f, card }] : [];
    }
    if (f.type === 'sources') return failed ? [] : [{ ...f, sources: group.sources }];
    if (f.type === 'follow_ups') return failed ? [] : [{ ...f, groups: group.followUps }];
    if (f.type === 'proposal') return [];
    if (f.type === 'error' && !textSent && group.text)
      return [{ ...f, error: { ...f.error, message: group.text } }];
    if (f.type === 'done' && failed)
      return [
        {
          type: 'error',
          seq: f.seq,
          messageId: f.messageId,
          error: {
            code:
              group.result === 'timeout' ? 'ASSISTANT_RENDER_TIMEOUT' : 'ASSISTANT_RENDER_FAILED',
            message: LOAD_ERROR[locale],
            field_errors: [],
            request_id: null,
            retryable: true,
          },
        },
      ];
    return [f];
  });
}
