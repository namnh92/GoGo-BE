import { describe, expect, it, vi } from 'vitest';
import { InMemoryFrameBuffer, type AssistantFrameBuffer } from '../infrastructure/frame-buffer';
import { AssistantTurnRunner, deriveTitle } from './assistant-turn-runner.service';
import { parseLastEventId, synthesizeFrames } from './assistant-stream.service';
import type { AssistantOrchestrator, TurnInput } from './assistant-orchestrator.service';
import type { AssistantRepository, MessageRow } from '../infrastructure/assistant.repository';
import type { AssistantAvailabilityService } from './assistant-availability.service';
import type { AssistantConfig } from './assistant.config';
import type { TurnSink, TurnState } from './turn-state';

/** An expiry far in the future: the write is not late. */
const FAR = Date.now() + 3_600_000;

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
  opts: {
    replyMaxMs?: number;
    killSwitch?: () => boolean;
    /** false: another writer (a stop, the reaper) finalized first. */
    finalizeWins?: boolean;
    purges?: string[];
    buffer?: AssistantFrameBuffer;
    /** Holds finalizeMessage's answer until it resolves. */
    finalizeGate?: Promise<void>;
  } = {},
) {
  const buffer = opts.buffer ?? new InMemoryFrameBuffer();
  const finalized: Finalized[] = [];
  const finalizeOptions: unknown[] = [];
  const ledger: { status: string }[] = [];
  const closed: string[] = [];
  const purged: string[][] = [];
  const repo = {
    finalizeMessage: async (id: string, update: Finalized, options?: unknown) => {
      finalized.push({ ...update, id });
      finalizeOptions.push(options);
      if (opts.finalizeGate) await opts.finalizeGate;
      return opts.finalizeWins === false ? null : ({ id, conversation_id: 'c' } as MessageRow);
    },
    findMessageById: async (id: string) => ({ id }) as MessageRow,
    pendingBufferPurges: async () => opts.purges ?? [],
    completeBufferPurges: async (ids: string[]) => {
      purged.push([...ids]);
    },
    setTitleIfEmpty: async () => undefined,
    completeLedger: async (_id: string, status: string) => {
      ledger.push({ status });
    },
    renewLease: async () => true,
    expiredStreaming: async () => [],
    closeLedgerForMessage: async (id: string) => {
      closed.push(id);
    },
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
  return { runner, buffer, finalized, finalizeOptions, ledger, closed, purged, turn };
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
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

describe('AssistantTurnRunner — Astra round 1 (GoGo-BE#717)', () => {
  it('A-R-06: a Stop during a stage that then finishes normally still ends `stopped`', async () => {
    const h = harness(async (_state, sink, signal) => {
      await sink.emit({ type: 'delta', text: 'partial ' });
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      // The stage ignored the signal and returned as if nothing happened.
      return { status: 'complete' };
    });
    h.runner.start(h.turn);
    await new Promise((r) => setTimeout(r, 30));
    await h.runner.stopLocal('m1');
    expect(h.finalized[0]!.status).toBe('stopped');
    expect(h.ledger).toEqual([{ status: 'stopped' }]);
  });

  it('A-R-11: a runner that lost finalization publishes no terminal frame of its own', async () => {
    const h = harness(
      async (_state, sink) => {
        await sink.emit({ type: 'delta', text: 'late ' });
        return { status: 'complete' };
      },
      { finalizeWins: false },
    );
    h.runner.start(h.turn);
    await until(() => h.ledger.length === 1);
    const live = await h.buffer.read('m1', 0);
    expect(live.map((f) => f.type)).toEqual(['delta']);
  });

  it('A-R-11: the reaper finalizes only a turn whose lease lapsed, in the same statement', async () => {
    const h = harness(async () => ({ status: 'complete' }));
    await h.runner.finalizeOrphan({ id: 'm9', text: '' } as MessageRow, 'failed', null, {
      onlyIfLeaseExpired: true,
    });
    expect(h.finalizeOptions[0]).toEqual({ onlyIfLeaseExpired: true });
  });

  it('A-R-08: the reaper drops live buffers an erasure listed', async () => {
    const h = harness(async () => ({ status: 'complete' }), { purges: ['m7'] });
    await h.buffer.append('m7', [{ type: 'delta', seq: 1, messageId: 'm7', text: 'private' }], FAR);
    await h.runner.reap();
    expect(await h.buffer.read('m7', 0)).toEqual([]);
    expect(h.purged).toEqual([['m7']]);
  });
});

describe('AssistantTurnRunner — Astra round 2 (GoGo-BE#717)', () => {
  it('A-R2-07: a stalled live buffer does not hold the turn: it still finalizes', async () => {
    const stalled = new InMemoryFrameBuffer();
    stalled.append = () => new Promise<void>(() => undefined);
    const h = harness(
      async (_state, sink) => {
        await sink.emit({ type: 'step', step: 'writing' });
        await sink.emit({ type: 'delta', text: 'Xin chào' });
        return { status: 'complete' };
      },
      { buffer: stalled },
    );
    h.runner.start(h.turn);
    await until(() => h.finalized.length === 1, 4_000);
    expect(h.finalized[0]!.status).toBe('complete');
    expect(h.finalized[0]!.text).toBe('Xin chào');
  }, 8_000);

  it('A-R2-09: after an abort, a runner that loses finalization adds nothing to the buffer', async () => {
    const h = harness(
      async (_state, sink, signal) => {
        await sink.emit({ type: 'delta', text: 'before ' });
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        // Still producing after the stop: these frames would take the seq
        // the winner's terminal frame uses.
        await sink.emit({ type: 'delta', text: 'after' });
        await sink.emit({ type: 'notice', notice: { kind: 'empty', copyKey: 'x' } as never });
        return { status: 'complete' };
      },
      { finalizeWins: false },
    );
    h.runner.start(h.turn);
    await until(async () => (await h.buffer.read('m1', 0)).length === 1);
    await h.buffer.requestStop('m1');
    await until(() => h.ledger.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect((await h.buffer.read('m1', 0)).map((f) => f.seq)).toEqual([1]);
  });
});

describe('AssistantTurnRunner — Sol review (S-F-03)', () => {
  it('writes still queued long after the turn ended never land', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new InMemoryFrameBuffer();
    const land = slow.append.bind(slow);
    let first = true;
    slow.append = async (id, frames, notAfter) => {
      if (first) {
        first = false;
        await gate;
      }
      return land(id, frames, notAfter);
    };
    const h = harness(
      async (_state, sink) => {
        await sink.emit({ type: 'step', step: 'writing' });
        await sink.emit({ type: 'notice', notice: { kind: 'empty', copyKey: 'x' } as never });
        return { status: 'complete' };
      },
      { buffer: slow },
    );
    h.runner.start(h.turn);
    await until(() => h.ledger.length === 1, 5_000);
    // Far past the expiry: the stalled first write finally returns.
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3_600_000);
    try {
      release();
      await new Promise((r) => setTimeout(r, 20));
      expect(await slow.read('m1', 0)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }, 10_000);
});

describe('AssistantTurnRunner — Sol review round 2 (S2-F-02)', () => {
  it('a finalization answered after the write expiry publishes nothing', async () => {
    let releaseFinalize!: () => void;
    const finalizeGate = new Promise<void>((r) => (releaseFinalize = r));
    const h = harness(
      async (_state, sink, signal) => {
        await sink.emit({ type: 'delta', text: 'before ' });
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
        await sink.emit({ type: 'delta', text: 'held back' });
        return { status: 'complete' };
      },
      { finalizeGate },
    );
    h.runner.start(h.turn);
    await until(async () => (await h.buffer.read('m1', 0)).length === 1);
    await h.buffer.requestStop('m1');
    await until(() => h.finalized.length === 1);
    // The commit's answer comes back just after the turn's write expiry
    // (reply ceiling 60 s + 30 s grace), long before the frames' own TTL.
    const later = Date.now() + 120_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      releaseFinalize();
      await until(() => h.ledger.length === 1);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      spy.mockRestore();
    }
    expect((await h.buffer.read('m1', 0)).map((f) => f.seq)).toEqual([1]);
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
