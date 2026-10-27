import { describe, expect, it } from 'vitest';
import { InMemoryFrameBuffer } from '../infrastructure/frame-buffer';
import { AssistantTurnRunner, deriveTitle } from './assistant-turn-runner.service';
import { parseLastEventId, synthesizeFrames } from './assistant-stream.service';
import type { AssistantOrchestrator, TurnInput } from './assistant-orchestrator.service';
import type { AssistantRepository, MessageRow } from '../infrastructure/assistant.repository';
import type { AssistantAvailabilityService } from './assistant-availability.service';
import type { AssistantConfig } from './assistant.config';
import type { TurnSink, TurnState } from './turn-state';

/**
 * The runner's state machine — stop, kill switch, hard ceiling, frame folding
 * — driven by a scripted orchestrator. No model is involved: the script only
 * emits frames, so these tests say nothing about inference (the live suite
 * does) and everything about cancellation and persistence.
 */
type Finalized = Parameters<AssistantRepository['finalizeMessage']>[1] & { id: string };

function harness(
  script: (
    state: TurnState,
    sink: TurnSink,
    signal: AbortSignal,
  ) => Promise<{ status: 'complete' | 'fallback' | 'truncated' }>,
  opts: { replyMaxMs?: number; killSwitch?: () => boolean } = {},
) {
  const buffer = new InMemoryFrameBuffer();
  const finalized: Finalized[] = [];
  const ledger: { status: string }[] = [];
  const repo = {
    finalizeMessage: async (id: string, update: Finalized) => {
      finalized.push({ ...update, id });
      return { id, conversation_id: 'c' } as MessageRow;
    },
    setTitleIfEmpty: async () => undefined,
    completeLedger: async (_id: string, status: string) => {
      ledger.push({ status });
    },
    renewLease: async () => true,
    expiredStreaming: async () => [],
    closeLedgerForMessage: async () => undefined,
  } as unknown as AssistantRepository;
  const orchestrator = {
    run: (_i: TurnInput, state: TurnState, sink: TurnSink, signal: AbortSignal) =>
      script(state, sink, signal),
  } as unknown as AssistantOrchestrator;
  const availability = {
    killSwitchOn: async () => (opts.killSwitch ? opts.killSwitch() : true),
  } as unknown as AssistantAvailabilityService;
  const config = { ASSISTANT_REPLY_MAX_MS: opts.replyMaxMs ?? 60_000 } as AssistantConfig;
  const runner = new AssistantTurnRunner(
    orchestrator,
    repo,
    availability,
    buffer,
    'test-instance',
    config,
  );
  const turn = {
    messageId: 'm1',
    conversationId: 'c',
    userId: 'u',
    ledgerId: 'l',
    text: 'xin chào',
    locale: 'vi' as const,
    context: null,
  };
  return { runner, buffer, finalized, ledger, turn };
}

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const waitAbort = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
  );

describe('AssistantTurnRunner', () => {
  it('a completed turn folds every frame, numbered, ending with done', async () => {
    const h = harness(async (_state, sink) => {
      await sink.emit({ type: 'step', step: 'writing' });
      await sink.emit({ type: 'delta', text: 'Xin ' });
      await sink.emit({ type: 'delta', text: 'chào' });
      await sink.emit({
        type: 'card',
        card: {
          kind: 'place',
          placeId: 'p1',
          available: true,
          facts: { name: 'Nhà Lá', priceMin: 45000 },
        },
      });
      return { status: 'complete' };
    });
    h.runner.start(h.turn);
    await until(() => h.finalized.length === 1);
    const f = h.finalized[0]!;
    expect(f.status).toBe('complete');
    expect(f.text).toBe('Xin chào');
    expect(f.frames!.map((x) => [x.seq, x.type])).toEqual([
      [1, 'step'],
      [2, 'delta'],
      [3, 'card'],
      [4, 'done'],
    ]);
    // Cards are stored as refs: no place fact is kept in the frames.
    expect(f.frames![2]).toMatchObject({ card: { kind: 'place', placeId: 'p1' } });
    expect(JSON.stringify(f.frames)).not.toContain('Nhà Lá');
    expect(f.cards).toEqual([{ kind: 'place', placeId: 'p1' }]);
    // The live buffer holds the same frames for SSE readers.
    expect((await h.buffer.read('m1', 0)).map((x) => x.seq)).toEqual([1, 2, 3, 4]);
    expect(h.ledger).toEqual([{ status: 'complete' }]);
  });

  it('Stop keeps the partial text and ends `stopped`', async () => {
    const h = harness(async (_state, sink, signal) => {
      await sink.emit({ type: 'delta', text: 'Để bình chọn, mở kế hoạch và ' });
      return waitAbort(signal);
    });
    h.runner.start(h.turn);
    await new Promise((r) => setTimeout(r, 50));
    expect(await h.runner.stopLocal('m1')).toBe(true);
    const f = h.finalized[0]!;
    expect(f.status).toBe('stopped');
    expect(f.text).toBe('Để bình chọn, mở kế hoạch và ');
    expect(f.frames![f.frames!.length - 1]).toMatchObject({ type: 'done', status: 'stopped' });
    // Stopping again is a no-op: nothing is running here any more.
    expect(await h.runner.stopLocal('m1')).toBe(false);
  });

  it('a stop requested from another instance (buffer flag) is honoured', async () => {
    const h = harness(async (_state, sink, signal) => {
      await sink.emit({ type: 'delta', text: 'partial ' });
      return waitAbort(signal);
    });
    h.runner.start(h.turn);
    await h.buffer.requestStop('m1');
    await until(() => h.finalized.length === 1);
    expect(h.finalized[0]!.status).toBe('stopped');
  });

  it('the kill switch turning off mid-reply ends it with ASSISTANT_DISABLED, partial text kept', async () => {
    let on = true;
    const h = harness(
      async (_state, sink, signal) => {
        await sink.emit({ type: 'delta', text: 'Sure — ' });
        on = false;
        return waitAbort(signal);
      },
      { killSwitch: () => on },
    );
    h.runner.start(h.turn);
    await until(() => h.finalized.length === 1, 6_000);
    const f = h.finalized[0]!;
    expect(f.status).toBe('failed');
    expect(f.error?.code).toBe('ASSISTANT_DISABLED');
    expect(f.text).toBe('Sure — ');
    expect(f.frames![f.frames!.length - 1]).toMatchObject({ type: 'error' });
  }, 10_000);

  it('the hard ceiling ends `truncated` and drops unfinished follow-ups', async () => {
    const h = harness(
      async (_state, sink, signal) => {
        await sink.emit({ type: 'delta', text: 'long ' });
        await sink.emit({
          type: 'follow_ups',
          groups: [{ field: 'date', label: 'Ngày?', options: [] }],
        });
        return waitAbort(signal);
      },
      { replyMaxMs: 100 },
    );
    h.runner.start(h.turn);
    await until(() => h.finalized.length === 1);
    expect(h.finalized[0]!.status).toBe('truncated');
    expect(h.finalized[0]!.followUps).toEqual([]);
  });

  it('a provider crash before any text ends `failed` with a retryable envelope', async () => {
    const h = harness(async () => {
      throw new Error('boom');
    });
    h.runner.start(h.turn);
    await until(() => h.finalized.length === 1);
    expect(h.finalized[0]!.status).toBe('failed');
    expect(h.finalized[0]!.error).toMatchObject({
      code: 'ASSISTANT_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });
});

describe('stream helpers', () => {
  it('Last-Event-ID is the seq; anything else replays from the start', () => {
    expect(parseLastEventId('7')).toBe(7);
    expect(parseLastEventId('abc')).toBe(0);
    expect(parseLastEventId('-1')).toBe(0);
    expect(parseLastEventId(undefined)).toBe(0);
  });

  it('a reply finalized without frames still replays to a terminal frame', () => {
    const frames = synthesizeFrames({
      id: 'm',
      status: 'failed',
      text: 'partial',
      cards: [{ kind: 'place', placeId: 'p' }],
      follow_ups: [],
      notice: null,
      error: null,
    } as unknown as MessageRow);
    expect(frames.map((f) => f.type)).toEqual(['delta', 'card', 'error']);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it('titles come from the user text, cut at a word', () => {
    expect(deriveTitle('  Tối nay   ăn gì ')).toBe('Tối nay ăn gì');
    const long = deriveTitle(
      'Tối nay hai đứa mình muốn đi ăn tối ở một chỗ thật yên tĩnh và lãng mạn gần Hồ Tây',
    );
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith('…')).toBe(true);
  });
});
