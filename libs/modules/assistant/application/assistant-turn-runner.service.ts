import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import type {
  AssistantDoneStatus,
  AssistantFrame,
  AssistantFrameInput,
  AssistantTerminalStatus,
  ErrorEnvelope,
} from '../domain/assistant.types';
import { AssistantRepository, type MessageRow } from '../infrastructure/assistant.repository';
import { ASSISTANT_FRAME_BUFFER, type AssistantFrameBuffer } from '../infrastructure/frame-buffer';
import { ASSISTANT_INSTANCE_ID, LEASE_MS, LEASE_RENEW_MS } from './assistant.config';
import { AssistantAvailabilityService } from './assistant-availability.service';
import {
  AssistantOrchestrator,
  HaikuMidStreamError,
  type TurnInput,
} from './assistant-orchestrator.service';
import { APP_CONFIG } from '../../shared/config';
import type { AssistantConfig } from './assistant.config';
import {
  applyFrame,
  cardRef,
  newTurnState,
  type AbortReason,
  type TurnSink,
  type TurnState,
} from './turn-state';

/** Deltas are coalesced so a reply is tens of frames, not hundreds. */
const DELTA_FLUSH_MS = 120;
const DELTA_FLUSH_CHARS = 240;
const STOP_POLL_MS = 500;
const KILL_SWITCH_POLL_MS = 3_000;
const REAPER_MS = 60_000;
/** How long ending a turn waits for the live buffer to take its frames. */
const BUFFER_DRAIN_MS = 2_000;

export type RunnableTurn = TurnInput;

type Running = { controller: AbortController; reason: AbortReason | null; done: Promise<void> };

export function envelope(code: string, message: string, retryable: boolean): ErrorEnvelope {
  return { code, message, field_errors: [], request_id: null, retryable };
}

/**
 * GoGo-BE#713 — runs accepted turns in the API process, after the send's
 * transaction committed (no DB transaction is ever held across a model call).
 * The assistant row holds a generation lease this process renews; a process
 * that dies mid-reply loses it and the reaper (any instance) ends the turn
 * `failed` with the text checkpointed so far. Stop, the kill switch and the
 * hard ceiling abort through one AbortSignal; the partial text is kept.
 */
@Injectable()
export class AssistantTurnRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssistantTurnRunner.name);
  private readonly running = new Map<string, Running>();
  private reaper: NodeJS.Timeout | undefined;

  constructor(
    private readonly orchestrator: AssistantOrchestrator,
    private readonly repo: AssistantRepository,
    private readonly availability: AssistantAvailabilityService,
    @Inject(ASSISTANT_FRAME_BUFFER) private readonly buffer: AssistantFrameBuffer,
    @Inject(ASSISTANT_INSTANCE_ID) private readonly instanceId: string,
    @Inject(APP_CONFIG) private readonly config: AssistantConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  onModuleInit(): void {
    this.reaper = setInterval(() => void this.reap().catch(() => undefined), REAPER_MS);
    this.reaper.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    const all = [...this.running.values()];
    for (const r of all) this.abort(r, 'shutdown');
    await Promise.race([Promise.allSettled(all.map((r) => r.done)), sleep(5_000)]);
  }

  /** Fire and forget: the send already answered 202. */
  start(turn: RunnableTurn): void {
    const controller = new AbortController();
    const entry: Running = { controller, reason: null, done: Promise.resolve() };
    entry.done = this.execute(turn, entry).catch((err: unknown) => {
      this.logger.error({
        msg: 'assistant turn crashed',
        event: 'assistant.turn_crashed',
        error: (err as Error)?.name,
      });
    });
    this.running.set(turn.messageId, entry);
  }

  /** Stops a turn running in this process; resolves once it is finalized. */
  async stopLocal(messageId: string): Promise<boolean> {
    const entry = this.running.get(messageId);
    if (!entry) return false;
    this.abort(entry, 'stopped');
    await Promise.race([entry.done, sleep(5_000)]);
    return true;
  }

  isRunningHere(messageId: string): boolean {
    return this.running.has(messageId);
  }

  private abort(entry: Running, reason: AbortReason): void {
    if (entry.controller.signal.aborted) return;
    entry.reason = reason;
    entry.controller.abort();
  }

  private async execute(turn: RunnableTurn, entry: Running): Promise<void> {
    const turnStartedAt = Date.now();
    const signal = entry.controller.signal;
    const state = newTurnState();
    const frames: AssistantFrame[] = [];
    let seq = 0;
    let deltaBuffer = '';
    let deltaTimer: NodeJS.Timeout | undefined;
    let chain = Promise.resolve();
    /** Highest seq handed to the live buffer; later frames wait for the outcome. */
    let queuedUpTo = 0;
    const toBuffer = (list: AssistantFrame[]) => {
      if (list.length === 0) return;
      queuedUpTo = list[list.length - 1]!.seq;
      // A-R2-07: the turn never waits on the buffer. Frames stay ordered on
      // one chain; a stalled or failed append leaves a hole readers fill
      // from the row once the turn is finalized.
      chain = chain.then(() => this.buffer.append(turn.messageId, list)).catch(() => undefined);
    };

    const push = (frame: AssistantFrameInput) => {
      seq += 1;
      // Cards travel as refs: the reader hydrates facts from verified data.
      const stored =
        frame.type === 'card'
          ? { ...frame, card: cardRef(frame.card as Parameters<typeof cardRef>[0]) }
          : frame;
      const full = { ...stored, seq, messageId: turn.messageId } as AssistantFrame;
      frames.push(full);
      applyFrame(state, full);
      // A-R2-09: once aborted, this runner may be about to lose the turn to
      // a stop or the reaper, whose terminal frame takes the next seq. Its
      // frames go to the buffer only if it wins finalization (below).
      if (signal.aborted) return;
      toBuffer([full]);
    };
    const flushDelta = () => {
      if (deltaTimer) clearTimeout(deltaTimer);
      deltaTimer = undefined;
      if (!deltaBuffer) return;
      const text = deltaBuffer;
      deltaBuffer = '';
      push({ type: 'delta', text });
    };
    const sink: TurnSink = {
      emit: async (frame) => {
        if (frame.type === 'delta') {
          if (!state.textStarted) {
            // ADR-0036 §3G: time to first text over the whole path (Jev,
            // retrieval, Haiku or the deterministic reply), from turn start.
            this.metrics.observe(
              'assistant_first_text_seconds',
              (Date.now() - turnStartedAt) / 1000,
              {},
            );
          }
          // Counted as started at once, so the first-text deadline sees it.
          state.textStarted = true;
          deltaBuffer += frame.text;
          if (deltaBuffer.length >= DELTA_FLUSH_CHARS) flushDelta();
          else deltaTimer ??= setTimeout(flushDelta, DELTA_FLUSH_MS);
          return;
        }
        flushDelta();
        push(frame);
      },
    };
    const ceiling = setTimeout(
      () => this.abort(entry, 'ceiling'),
      this.config.ASSISTANT_REPLY_MAX_MS,
    );
    let lastKillSwitchCheck = Date.now();
    const watcher = setInterval(() => {
      void (async () => {
        if (signal.aborted) return;
        if (await this.buffer.stopRequested(turn.messageId).catch(() => false))
          this.abort(entry, 'stopped');
        if (Date.now() - lastKillSwitchCheck >= KILL_SWITCH_POLL_MS) {
          lastKillSwitchCheck = Date.now();
          if (!(await this.availability.killSwitchOn().catch(() => true)))
            this.abort(entry, 'kill_switch');
        }
      })();
    }, STOP_POLL_MS);
    const lease = setInterval(() => {
      void this.repo
        .renewLease(turn.messageId, this.instanceId, LEASE_MS, state.text)
        .then((held) => {
          // Someone else ended the turn (a stop on another instance, a delete).
          if (!held) this.abort(entry, 'deleted');
        })
        .catch(() => undefined);
    }, LEASE_RENEW_MS);

    let status: AssistantTerminalStatus;
    let error: ErrorEnvelope | null = null;
    try {
      const outcome = await this.orchestrator.run(turn, state, sink, signal);
      // A-R-06: a turn aborted while it was finishing ends as the abort says.
      signal.throwIfAborted();
      status = outcome.status;
    } catch (err) {
      if (!signal.aborted) {
        status = 'failed';
        error =
          err instanceof HaikuMidStreamError
            ? envelope(
                'ASSISTANT_PROVIDER_UNAVAILABLE',
                'The assistant could not finish this reply',
                true,
              )
            : envelope('ASSISTANT_PROVIDER_UNAVAILABLE', 'The assistant could not answer', true);
        if (!(err instanceof HaikuMidStreamError)) {
          this.logger.error({
            msg: 'assistant turn failed',
            event: 'assistant.turn_failed',
            error: (err as Error)?.name,
          });
        }
      } else {
        switch (entry.reason) {
          case 'stopped':
            status = 'stopped';
            break;
          case 'kill_switch':
            status = 'failed';
            error = envelope('ASSISTANT_DISABLED', 'Assistant is disabled', false);
            break;
          case 'ceiling':
            status = 'truncated';
            break;
          case 'deleted':
            status = 'failed';
            break;
          default:
            status = 'failed';
            error = envelope('ASSISTANT_INTERRUPTED', 'The reply was interrupted', true);
        }
      }
    } finally {
      clearTimeout(ceiling);
      clearInterval(watcher);
      clearInterval(lease);
    }

    try {
      flushDelta();
      // Bounded: a stalled buffer delays nothing durable (A-R2-07).
      await Promise.race([chain, sleep(BUFFER_DRAIN_MS)]);
      // The terminal frame is folded into the row first and reaches the live
      // buffer only after the commit: a client that sees `done` and re-reads
      // the message must find it finished.
      let terminal: AssistantFrame | null = null;
      if (entry.reason !== 'deleted') {
        seq += 1;
        terminal = (
          error
            ? { type: 'error', seq, messageId: turn.messageId, error }
            : {
                type: 'done',
                seq,
                messageId: turn.messageId,
                status: status as AssistantDoneStatus,
              }
        ) as AssistantFrame;
        frames.push(terminal);
      }
      const row = await this.repo.finalizeMessage(turn.messageId, {
        status,
        text: state.text,
        cards: state.cards,
        followUps: status === 'truncated' ? [] : state.followUps,
        notice: state.notice,
        error,
        frames,
        trace: state.trace,
        sources: state.sources,
      });
      // A-R-11 / A-R2-09: only the writer that finalized publishes — the
      // frames it held back after an abort, then its terminal. A runner that
      // lost to a stop or the reaper adds nothing after their terminal.
      if (row) toBuffer(frames.filter((f) => f.seq > queuedUpTo));
      if (row) await this.repo.setTitleIfEmpty(turn.conversationId, deriveTitle(turn.text));
      else if (!(await this.repo.findMessageById(turn.messageId))) {
        // Deleted (conversation or account) while it ran: no copy stays behind.
        await this.buffer.drop(turn.messageId).catch(() => undefined);
      }
      await this.repo.completeLedger(turn.ledgerId, status, state.costs);
      this.metrics.increment('assistant_turns_total', { status });
    } finally {
      this.running.delete(turn.messageId);
    }
  }

  /**
   * Turns whose lease lapsed (their process died): ended `failed`, keeping the
   * checkpointed text and whatever frames the buffer still holds.
   */
  async reap(): Promise<number> {
    await this.drainBufferPurges().catch(() => undefined);
    const expired = await this.repo.expiredStreaming(20);
    let reaped = 0;
    for (const row of expired) {
      if (this.running.has(row.id)) continue;
      if (
        await this.finalizeOrphan(
          row,
          'failed',
          envelope('ASSISTANT_INTERRUPTED', 'The reply was interrupted', true),
          { onlyIfLeaseExpired: true },
        )
      ) {
        reaped += 1;
      }
    }
    if (reaped > 0) this.metrics.increment('assistant_turns_total', { status: 'reaped' }, reaped);
    return reaped;
  }

  /**
   * Drops the live buffers of deleted replies (A-R-08, A-R2-08). A drop that
   * fails keeps its row, so the next pass retries it.
   */
  async drainBufferPurges(): Promise<void> {
    const ids = await this.repo.pendingBufferPurges(100);
    const dropped: string[] = [];
    for (const id of ids) {
      if (this.running.has(id)) this.abort(this.running.get(id)!, 'deleted');
      try {
        await this.buffer.drop(id);
        dropped.push(id);
      } catch {
        // retried on the next pass
      }
    }
    await this.repo.completeBufferPurges(dropped);
  }

  /** Ends a streaming turn no process here is running (stop fallback, reaper). */
  async finalizeOrphan(
    row: MessageRow,
    status: 'stopped' | 'failed',
    error: ErrorEnvelope | null,
    options: { onlyIfLeaseExpired?: boolean } = {},
  ): Promise<MessageRow | null> {
    const frames = await this.buffer.read(row.id, 0).catch(() => [] as AssistantFrame[]);
    const state: TurnState = newTurnState();
    for (const f of frames) applyFrame(state, f);
    if (!state.textStarted) state.text = row.text;
    const last = frames[frames.length - 1];
    const terminal: AssistantFrame = error
      ? { type: 'error', seq: (last?.seq ?? 0) + 1, messageId: row.id, error }
      : { type: 'done', seq: (last?.seq ?? 0) + 1, messageId: row.id, status: 'stopped' };
    const all = frames.length > 0 || state.text === '' ? [...frames, terminal] : null;
    const finalized = await this.repo.finalizeMessage(
      row.id,
      {
        status,
        text: state.text,
        cards: state.cards,
        followUps: state.followUps,
        notice: state.notice,
        error,
        frames: all,
        trace: { orphaned: true },
        sources: state.sources,
      },
      options,
    );
    if (finalized) {
      await this.buffer.append(row.id, [terminal]).catch(() => undefined);
      await this.repo.closeLedgerForMessage(row.id);
    }
    return finalized;
  }
}

/** First words of the user's own question — user text, never model text. */
export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean;
  const cut = clean.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).trim()}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
