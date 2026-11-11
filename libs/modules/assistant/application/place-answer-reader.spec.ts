import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoopMetrics } from '@gogo/observability';
import { PlaceAnswerReader } from './place-answer-reader';
import {
  fictionalPlace,
  fixtureRow,
  FIXTURE_A,
  FIXTURE_B,
  verified,
} from '../domain/place-qa/fixtures';
import { answerToken } from '../domain/place-qa/tokens';
import { LOAD_ERROR } from '../domain/place-qa/templates';
import type { PlaceFactContext, PlaceFactsReader } from '../domain/place-qa/place-facts';
import { AssistantStreamService, type SseMessage } from './assistant-stream.service';
import { InMemoryFrameBuffer } from '../infrastructure/frame-buffer';
import type { MessageRow } from '../infrastructure/assistant.repository';
import type { AssistantFrame } from '../domain/assistant.types';
const context = (): PlaceFactContext => ({
  places: new Map([
    [FIXTURE_A, fictionalPlace()],
    [FIXTURE_B, fictionalPlace(FIXTURE_B, 'Fictional Harbor')],
  ]),
});
afterEach(() => vi.useRealTimers());
describe('Sol confirm F-04: price comparison with one side missing', () => {
  it.each([
    [
      'vi',
      'GoGo chưa có giá đã xác minh của địa điểm này. Bạn xem thông tin trong thẻ địa điểm nhé.',
      '/người',
    ],
    [
      'en',
      'GoGo has no verified price for this place. Please see the place card for details.',
      '/person',
    ],
  ] as const)(
    'the missing side carries the wording and card pointer; the other side keeps its price (%s)',
    async (locale, wording, unit) => {
      const queries = [FIXTURE_A, FIXTURE_B].map((placeId) =>
        answerToken({ placeId, locale, topic: 'price' }),
      );
      const base = fixtureRow('m', [FIXTURE_A, FIXTURE_B]);
      const row = {
        ...base,
        locale,
        text: queries.join('\n'),
        trace: {
          ...base.trace,
          placeAnswerGroup: { ...base.trace.placeAnswerGroup, sources: queries, options: [] },
        },
      };
      const harbor = fictionalPlace(FIXTURE_B, 'Fictional Harbor');
      const { price: _price, ...withoutPrice } = harbor.facts;
      const places = new Map([
        [FIXTURE_A, fictionalPlace()],
        [FIXTURE_B, { ...harbor, facts: withoutPrice }],
      ]);
      const result = (
        await new PlaceAnswerReader({ placeFacts: async () => ({ places }) }).page([row], 'history')
      ).get('m')!;
      expect(result.result).toBe('ok');
      expect(result.text.split('\n')).toEqual([
        expect.stringContaining(`Fictional Lantern: 12000–24000 VND${unit}`),
        `Fictional Harbor: ${wording}`,
      ]);
      // Unknown price stays hidden on the card; only the known side is a source.
      expect(result.cards.map((c) => c.facts.priceMin)).toEqual([12000, undefined]);
      expect(result.sources).toHaveLength(1);
    },
  );
});
describe('atomic response reader boundary', () => {
  it('reads both compare slots once and uses the same snapshot for prose/cards/source/options', async () => {
    const port = { placeFacts: vi.fn(async (_ids: readonly string[]) => context()) };
    const row = fixtureRow('m', [FIXTURE_A, FIXTURE_B]);
    const reader = new PlaceAnswerReader(port);
    const result = (await reader.page([row], 'history')).get('m')!;
    expect(port.placeFacts).toHaveBeenCalledOnce();
    expect(port.placeFacts.mock.calls[0]?.[0]).toEqual([FIXTURE_A, FIXTURE_B]);
    expect(result.text).toContain('Lantern: 12000–24000 VND/person');
    expect(result.text).toContain('Harbor: 12000–24000 VND/person');
    expect(result.cards[0]?.facts.priceMin).toBe(12000);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]?.checkedAt).toBeUndefined();
    expect(result.followUps[0]?.options).toEqual([{ id: 'hours', label: 'Hours', text: 'Hours' }]);
    expect(JSON.stringify(row)).not.toMatch(/Lantern|12000|Fictional Street/);
  });
  it('rechecks fact, source and option eligibility on every connection and suppresses stale card values', async () => {
    let snapshot = context();
    const reader = new PlaceAnswerReader({ placeFacts: async () => snapshot });
    const row = fixtureRow();
    const first = (await reader.page([row], 'history')).get(row.id)!;
    snapshot = {
      places: new Map([
        [
          FIXTURE_A,
          {
            ...fictionalPlace(),
            facts: {
              price: [
                verified(
                  [{ min: 900, max: 900, currency: 'USD', unit: 'per_hour' }],
                  'verified_reference',
                ),
              ],
            },
          },
        ],
      ]),
    };
    const next = (await reader.page([row], 'history')).get(row.id)!;
    expect(first.cards[0]?.facts.priceMin).toBe(12000);
    expect(next.cards[0]?.facts.priceMin).toBeUndefined();
    expect(next.text).toContain('9.00 USD/hour');
    expect(next.text).toContain('Reference information');
    expect(next.followUps).toEqual([]);
    snapshot = { places: new Map([[FIXTURE_A, { ...fictionalPlace(), available: false }]]) };
    const closed = (await reader.page([row], 'history')).get(row.id)!;
    expect(closed.result).toBe('unavailable');
    expect(closed.sources).toEqual([]);
    expect(closed.cards[0]?.available).toBe(false);
  });
  it.each(['history', 'cms', 'replay', 'live'] as const)(
    'DB failure on %s is a load error, never false unavailable',
    async (surface) => {
      const reader = new PlaceAnswerReader({
        placeFacts: async () => {
          throw new Error('fixture DB failure');
        },
      });
      const result = (await reader.page([fixtureRow()], surface, { acceptedAt: Date.now() })).get(
        'message-a',
      )!;
      expect(result).toEqual({
        text: LOAD_ERROR.en,
        cards: [],
        sources: [],
        followUps: [],
        result: 'read_error',
      });
    },
  );
  it('uses the smaller live budget and makes no read when the accepted-turn allowance has expired', async () => {
    const port = { placeFacts: vi.fn(async (_ids: readonly string[]) => context()) };
    const reader = new PlaceAnswerReader(port);
    const result = (
      await reader.page([fixtureRow()], 'live', { acceptedAt: Date.now() - 15001 })
    ).get('message-a')!;
    expect(result.result).toBe('timeout');
    expect(port.placeFacts).not.toHaveBeenCalled();
  });
  it('bounds an adapter that ignores cancel to 2s and aborts the SQL port signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const port: PlaceFactsReader = {
      placeFacts: async (_ids, o) => {
        signal = o.signal;
        return new Promise(() => {});
      },
    };
    const reader = new PlaceAnswerReader(port);
    const pending = reader.page([fixtureRow()], 'replay');
    await vi.advanceTimersByTimeAsync(2000);
    expect((await pending).get('message-a')?.result).toBe('timeout');
    expect(signal?.aborted).toBe(true);
  });
  it.each(['rejects on cancel', 'ignores cancel'] as const)(
    'S1 race: the allowance timer decides timeout before it aborts (%s), whatever the wall clock reads',
    async (adapter) => {
      // Only the scheduler is faked. Date stays pinned, as when a timer fires a
      // tick early: elapsed wall-clock time can never rescue the classification.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-11T10:00:00Z'));
      try {
        let signal: AbortSignal | undefined;
        const reader = new PlaceAnswerReader({
          placeFacts: (_ids, o) => {
            signal = o.signal;
            return new Promise((_resolve, reject) => {
              if (adapter === 'rejects on cancel')
                o.signal.addEventListener('abort', () => reject(new Error('query cancelled')), {
                  once: true,
                });
            });
          },
        });
        const pending = reader.page([fixtureRow()], 'replay');
        await vi.advanceTimersByTimeAsync(2000);
        expect((await pending).get('message-a')?.result).toBe('timeout');
        expect(signal?.aborted).toBe(true);
      } finally {
        clock.mockRestore();
      }
    },
  );
  it('S1 race: a caller cancellation before the allowance stays read_error with a pinned clock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-11T10:00:00Z'));
    try {
      const abort = new AbortController();
      const reader = new PlaceAnswerReader({ placeFacts: () => new Promise(() => {}) });
      const pending = reader.page([fixtureRow()], 'replay', { signal: abort.signal });
      await vi.advanceTimersByTimeAsync(1999);
      abort.abort();
      expect((await pending).get('message-a')?.result).toBe('read_error');
    } finally {
      clock.mockRestore();
    }
  });
  it('includes all DB work in the remaining first-visible allowance, with no extra 2s', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    let deadline = 0;
    const reader = new PlaceAnswerReader({
      placeFacts: async (_ids, o) => {
        deadline = o.deadlineAt;
        return new Promise(() => {});
      },
    });
    const pending = reader.page([fixtureRow()], 'live', { acceptedAt: now - 14900 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).get('message-a')?.result).toBe('timeout');
    expect(deadline).toBe(now + 100);
  });
  it('disconnect cancels only reader work, without any producer mutation', async () => {
    const abort = new AbortController();
    let signal: AbortSignal | undefined;
    const reader = new PlaceAnswerReader({
      placeFacts: async (_ids, o) => {
        signal = o.signal;
        return new Promise(() => {});
      },
    });
    const pending = reader.page([fixtureRow()], 'live', {
      signal: abort.signal,
      acceptedAt: Date.now(),
    });
    abort.abort();
    expect((await pending).get('message-a')?.result).toBe('read_error');
    expect(signal?.aborted).toBe(true);
  });
  it('bounds page reads to 30 distinct ids and never hydrates overflow cards separately', async () => {
    const rows = Array.from({ length: 31 }, (_, i) =>
      fixtureRow(`m${i}`, [`${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`]),
    );
    let ids: readonly string[] = [];
    const reader = new PlaceAnswerReader({
      placeFacts: async (input) => {
        ids = input;
        return { places: new Map(input.map((id) => [id, fictionalPlace(id)])) };
      },
    });
    const groups = await reader.page(rows, 'history');
    expect(ids).toHaveLength(30);
    expect(groups.get('m30')?.text).toContain('Price: this place');
    expect(groups.get('m30')?.cards[0]?.facts).toEqual({ name: 'this place' });
  });
  it('unknown versions and malformed groups are neutral and never reach the port', async () => {
    const metrics = new NoopMetrics();
    const increment = vi.spyOn(metrics, 'increment');
    const port = { placeFacts: vi.fn(async (_ids: readonly string[]) => context()) };
    const row = fixtureRow();
    row.trace.placeAnswerGroup = { ...row.trace.placeAnswerGroup, v: 99 as 1 };
    const result = (await new PlaceAnswerReader(port, metrics).page([row], 'history')).get(row.id)!;
    expect(result.result).toBe('unknown_token');
    expect(result.text).toBe('this place');
    expect(port.placeFacts).not.toHaveBeenCalled();
    expect(increment).toHaveBeenCalledWith('assistant_place_answer_render_total', {
      mode: 'history',
      result: 'unknown_token',
    });
  });
  it('three-candidate clarification uses one snapshot with reference-only choice labels', async () => {
    const cards = [FIXTURE_A, FIXTURE_B, '33333333-3333-4333-8333-333333333333'];
    const text = cards.map((id) => `\uE000place:${id}\uE001`).join(', ');
    const row = {
      id: 'choices',
      text,
      locale: 'vi' as const,
      trace: {
        route: 'place_qa',
        placeAnswerGroup: {
          v: 1,
          kind: 'clarification',
          cards,
          sources: [],
          options: [
            ...cards.map((placeId, i) => ({ id: `c${i}`, placeId })),
            { id: 'none', none: true },
          ],
        },
      },
    };
    const port = {
      placeFacts: vi.fn(async (ids: readonly string[]) => ({
        places: new Map(ids.map((id, i) => [id, fictionalPlace(id, `Fictional ${i + 1}`)])),
      })),
    };
    const result = (await new PlaceAnswerReader(port).page([row], 'history')).get('choices')!;
    expect(result.cards).toHaveLength(3);
    expect(result.followUps[0]?.options).toHaveLength(4);
    expect(result.followUps[0]?.options[0]).toEqual({
      id: 'c0',
      label: '1. Fictional 1',
      text: '1',
    });
    expect(port.placeFacts).toHaveBeenCalledOnce();
    expect(result.text).toContain('Fictional 3');
  });
});
function storedRow(): MessageRow {
  const ref = fixtureRow('m', [FIXTURE_A, FIXTURE_B]);
  const frames: AssistantFrame[] = [
    { type: 'delta', seq: 1, messageId: 'm', text: ref.text },
    { type: 'card', seq: 2, messageId: 'm', card: { kind: 'place', placeId: FIXTURE_A } },
    { type: 'card', seq: 3, messageId: 'm', card: { kind: 'place', placeId: FIXTURE_B } },
    { type: 'sources', seq: 4, messageId: 'm', sources: [] },
    { type: 'follow_ups', seq: 5, messageId: 'm', groups: [] },
    { type: 'done', seq: 6, messageId: 'm', status: 'complete' },
  ];
  return {
    ...ref,
    conversation_id: 'c',
    user_id: 'u',
    role: 'assistant',
    status: 'complete',
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    cards: [],
    follow_ups: [],
    notice: null,
    error: null,
    frames,
    context_kind: null,
    context_id: null,
    lease_owner: null,
    lease_expires_at: null,
  };
}
async function collect(service: AssistantStreamService, last: string | null = null) {
  const stream = await service.stream({ type: 'user', id: 'u', sessionId: 's' }, 'c', 'm', last);
  const messages: SseMessage[] = [];
  await new Promise<void>((resolve) =>
    stream.subscribe({ next: (f) => messages.push(f), complete: resolve }),
  );
  return messages
    .filter((f): f is { id?: string; type: string; data: string } => 'type' in f)
    .map((f) => ({ id: f.id, type: f.type, body: JSON.parse(f.data) }));
}
describe('SSE committed group delivery', () => {
  it('reconnect preloads both sides including refs before Last-Event-ID and preserves suffix sequences', async () => {
    const row = storedRow();
    const port = { placeFacts: vi.fn(async (_ids: readonly string[]) => context()) };
    const hydrate = vi.fn();
    const repo = { findMessage: async () => row };
    const service = new AssistantStreamService(
      repo as never,
      { hydrate } as never,
      new InMemoryFrameBuffer(),
      undefined,
      new PlaceAnswerReader(port),
    );
    const frames = await collect(service, '2');
    expect(port.placeFacts.mock.calls[0]?.[0]).toEqual([FIXTURE_A, FIXTURE_B]);
    expect(frames.map((f) => f.id)).toEqual(['3', '4', '5', '6']);
    expect(frames[0]?.body.card.facts.name).toBe('Fictional Harbor');
    expect(hydrate).not.toHaveBeenCalled();
  });
  it('producer completion followed by reader failure ends with fixed error text/error, no false done', async () => {
    const row = storedRow();
    const service = new AssistantStreamService(
      { findMessage: async () => row } as never,
      {} as never,
      new InMemoryFrameBuffer(),
      undefined,
      new PlaceAnswerReader({
        placeFacts: async () => {
          throw new Error('DB down');
        },
      }),
    );
    const frames = await collect(service);
    expect(frames.map((f) => f.type)).toEqual(['delta', 'error']);
    expect(frames[0]?.body.text).toBe(LOAD_ERROR.en);
    expect(frames[1]?.body.error.code).toBe('ASSISTANT_RENDER_FAILED');
    expect(row.status).toBe('complete');
  });
  it('live attachment waits for the committed group, charges its existing TTFT allowance and measures delivery only', async () => {
    const row = storedRow();
    row.created_at = new Date(Date.now() - 15001).toISOString();
    let reads = 0;
    const repo = {
      findMessage: async () => (++reads === 1 ? { ...row, status: 'streaming' } : row),
    };
    const buffer = new InMemoryFrameBuffer();
    await buffer.append('m', row.frames!, Date.now() + 10000);
    const port = { placeFacts: vi.fn(async (_ids: readonly string[]) => context()) };
    const metrics = new NoopMetrics();
    const observe = vi.spyOn(metrics, 'observe');
    const service = new AssistantStreamService(
      repo as never,
      {} as never,
      buffer,
      metrics,
      new PlaceAnswerReader(port),
    );
    const frames = await collect(service);
    expect(port.placeFacts).not.toHaveBeenCalled();
    expect(frames.map((f) => f.type)).toEqual(['delta', 'error']);
    expect(frames[1]?.body.error.code).toBe('ASSISTANT_RENDER_TIMEOUT');
    expect(observe).toHaveBeenCalledWith(
      'assistant_place_answer_first_visible_text_seconds',
      expect.any(Number),
      { mode: 'live' },
    );
  });
  it('date-specific replay retains the requested date rather than recomputing today', async () => {
    const q = answerToken({
      placeId: FIXTURE_A,
      locale: 'en',
      topic: 'hours',
      day: 'date',
      date: '2026-11-11',
      d: 3,
      tz: 'Asia/Ho_Chi_Minh',
    });
    const row = fixtureRow();
    row.text = q;
    row.trace.placeAnswerGroup = { ...row.trace.placeAnswerGroup, sources: [q] };
    const result = (
      await new PlaceAnswerReader({ placeFacts: async () => context() }).page([row], 'replay')
    ).get(row.id)!;
    expect(result.text).toContain('requested date 2026-11-11');
    expect(result.text).toContain('Regular weekly hours for Wednesday');
  });
});

describe('additional S1 integrity cells', () => {
  it('rejects a projection for a different id instead of rendering the wrong place', async () => {
    const reader = new PlaceAnswerReader({
      placeFacts: async () => ({ places: new Map([[FIXTURE_A, fictionalPlace(FIXTURE_B)]]) }),
    });
    expect((await reader.page([fixtureRow()], 'history')).get('message-a')?.result).toBe(
      'read_error',
    );
  });
  it('malformed capacity is unsupported wording with no numeric clamp or lookup', async () => {
    const row = fixtureRow();
    row.text = `\uE000a1:${FIXTURE_A}:en:suitability:n=100\uE001`;
    const port = { placeFacts: vi.fn(async () => context()) };
    const result = (await new PlaceAnswerReader(port).page([row], 'history')).get(row.id)!;
    expect(result.text).toBe('GoGo has no capacity data; please ask the place directly.');
    expect(result.text).not.toContain('99');
    expect(port.placeFacts).not.toHaveBeenCalled();
  });
  it('Google card rating stays attributed and never becomes GoGo-verified prose or a blended score', async () => {
    const row = fixtureRow();
    const p = {
      ...fictionalPlace(),
      facts: {
        providerRating: {
          current: true,
          score: 4.5,
          count: 30,
          source: { kind: 'google' as const, collectedAt: '2026-11-10T00:00:00Z' },
        },
      },
    };
    const result = (
      await new PlaceAnswerReader({
        placeFacts: async () => ({ places: new Map([[FIXTURE_A, p]]) }),
      }).page([row], 'history')
    ).get(row.id)!;
    expect(result.cards[0]?.facts).toMatchObject({
      providerRating: 4.5,
      providerRatingCount: 30,
      providerRatingSource: 'google',
    });
    expect(result.text).not.toContain('4.5');
    expect(result.sources).toEqual([]);
  });
  it('a reconnect at the terminal cursor emits no invented sequence', async () => {
    const row = storedRow();
    const service = new AssistantStreamService(
      { findMessage: async () => row } as never,
      {} as never,
      new InMemoryFrameBuffer(),
      undefined,
      new PlaceAnswerReader({ placeFacts: async () => context() }),
    );
    expect(await collect(service, '6')).toEqual([]);
  });
});

describe('S1 route and producer timing races', () => {
  it('detects a QA marker written after attachment, before hydrating an early buffered card', async () => {
    const row = storedRow();
    let reads = 0;
    const buffer = new InMemoryFrameBuffer();
    await buffer.append(
      'm',
      [row.frames![1]!, row.frames![2]!].map((f, i) => ({ ...f, seq: i + 1 })),
      Date.now() + 10000,
    );
    const repo = {
      findMessage: async () =>
        ++reads === 1 ? { ...row, status: 'streaming', text: '', trace: {} } : row,
    };
    const hydrate = vi.fn();
    const frames = await collect(
      new AssistantStreamService(
        repo as never,
        { hydrate } as never,
        buffer,
        undefined,
        new PlaceAnswerReader({ placeFacts: async () => context() }),
      ),
    );
    expect(hydrate).not.toHaveBeenCalled();
    expect(frames[0]?.body.text).toContain('Fictional Lantern');
  });
  it('expires attached QA while its producer is still streaming without adopting a false resume id', async () => {
    const row = {
      ...storedRow(),
      status: 'streaming',
      created_at: new Date(Date.now() - 15001).toISOString(),
    };
    const port = { placeFacts: vi.fn(async () => context()) };
    const frames = await collect(
      new AssistantStreamService(
        { findMessage: async () => row } as never,
        {} as never,
        new InMemoryFrameBuffer(),
        undefined,
        new PlaceAnswerReader(port),
      ),
    );
    expect(frames.map((f) => f.type)).toEqual(['delta', 'error']);
    expect(frames.every((f) => f.id === undefined)).toBe(true);
    expect(port.placeFacts).not.toHaveBeenCalled();
    expect(row.status).toBe('streaming');
  });
});

describe('S1 metadata-read failure', () => {
  it('sends a fixed error if the QA row refresh fails after SSE attachment', async () => {
    const row = { ...storedRow(), status: 'streaming' };
    let reads = 0;
    const service = new AssistantStreamService(
      {
        findMessage: async () => {
          if (++reads === 1) return row;
          throw new Error('fixture DB error');
        },
      } as never,
      {} as never,
      new InMemoryFrameBuffer(),
    );
    const frames = await collect(service);
    expect(frames.map((f) => f.type)).toEqual(['delta', 'error']);
    expect(frames[1]?.body.error.code).toBe('ASSISTANT_RENDER_FAILED');
  });
});

describe('round-1 malformed writer regressions', () => {
  it.each([
    'prose only',
    'mixed prose',
    'identity only',
    'missing compare slot',
    'metadata-only source',
  ])('rejects %s before facts are loaded or writer prose is exposed', async (scenario) => {
    const row = fixtureRow(
      'bad',
      scenario === 'missing compare slot' ? [FIXTURE_A, FIXTURE_B] : [FIXTURE_A],
    );
    if (scenario === 'prose only') row.text = 'Secret Cafe costs 123 VND';
    if (scenario === 'mixed prose') row.text += '\nSecret Cafe costs 123 VND';
    if (scenario === 'identity only') row.text = `\uE000place:${FIXTURE_A}\uE001`;
    if (scenario === 'missing compare slot') {
      row.text = row.text.split('\n')[0]!;
      row.trace.placeAnswerGroup = {
        ...row.trace.placeAnswerGroup,
        sources: [row.trace.placeAnswerGroup.sources[0]!],
      };
    }
    if (scenario === 'metadata-only source')
      row.trace.placeAnswerGroup = {
        ...row.trace.placeAnswerGroup,
        sources: [answerToken({ placeId: FIXTURE_A, locale: 'en', topic: 'address' })],
      };
    const port = { placeFacts: vi.fn(async () => context()) };
    const result = (await new PlaceAnswerReader(port).page([row], 'history')).get('bad')!;
    expect(result.result).toBe('unknown_token');
    expect(port.placeFacts).not.toHaveBeenCalled();
    expect(result.text).not.toMatch(/Secret Cafe|123|Lantern/);
    expect(result.cards).toEqual([]);
    expect(result.sources).toEqual([]);
  });
});

describe('round-1 absolute attachment deadline', () => {
  it.each(['buffer read', 'metadata read', 'buffer wait'] as const)(
    'times out while %s is stalled and ignores its late completion',
    async (stage) => {
      vi.useFakeTimers();
      const row = {
        ...storedRow(),
        status: 'streaming',
        created_at: new Date(Date.now() - 14900).toISOString(),
      };
      const buffer = new InMemoryFrameBuffer();
      let unblock!: () => void;
      const stalled = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      if (stage === 'buffer read')
        vi.spyOn(buffer, 'read').mockImplementation(async () => {
          await stalled;
          return [];
        });
      if (stage === 'buffer wait') vi.spyOn(buffer, 'wait').mockImplementation(() => stalled);
      let reads = 0;
      const repo = {
        findMessage: async () => {
          if (++reads > 1 && stage === 'metadata read') await stalled;
          return row;
        },
      };
      const port = { placeFacts: vi.fn(async () => context()) };
      const stream = await new AssistantStreamService(
        repo as never,
        {} as never,
        buffer,
        undefined,
        new PlaceAnswerReader(port),
      ).stream({ type: 'user', id: 'u', sessionId: 's' }, 'c', 'm', null);
      const events: SseMessage[] = [];
      let completed = false;
      const subscription = stream.subscribe({
        next: (e) => events.push(e),
        complete: () => {
          completed = true;
        },
      });
      await vi.advanceTimersByTimeAsync(100);
      const completedAtDeadline = completed;
      const deadlineEvents = [...events];
      unblock();
      await vi.advanceTimersByTimeAsync(0);
      subscription.unsubscribe();
      expect(completedAtDeadline).toBe(true);
      expect(
        deadlineEvents
          .filter((e) => 'type' in e)
          .map((e) => JSON.parse((e as { data: string }).data).type),
      ).toEqual(['delta', 'error']);
      expect(JSON.stringify(deadlineEvents)).toContain('ASSISTANT_RENDER_TIMEOUT');
      expect(events).toEqual(deadlineEvents);
      expect(port.placeFacts).not.toHaveBeenCalled();
      expect(row.status).toBe('streaming');
    },
  );
});
