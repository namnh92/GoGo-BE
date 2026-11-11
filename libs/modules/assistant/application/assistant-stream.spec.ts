import { describe, expect, it, vi } from 'vitest';
import { InMemoryFrameBuffer } from '../infrastructure/frame-buffer';
import { AssistantStreamService, type SseMessage } from './assistant-stream.service';
import type { MessageRow } from '../infrastructure/assistant.repository';
import type { AssistantFrame } from '../domain/assistant.types';

/** An expiry far in the future: the write is not late. */
const FAR = Date.now() + 3_600_000;

describe('stream admission and buffered resume after deletion', () => {
  it.each([null, '1'])(
    'refuses missing/deleted/foreign rows before reading frames (resume=%s)',
    async (lastEventId) => {
      const buffer = new InMemoryFrameBuffer();
      await buffer.append(
        'm',
        [{ type: 'delta', seq: 2, messageId: 'm', text: 'deleted answer' }],
        FAR,
      );
      const read = vi.spyOn(buffer, 'read');
      const findMessage = vi.fn().mockResolvedValue(null);
      const service = new AssistantStreamService({ findMessage } as never, {} as never, buffer);
      // Rejections must release the actor's slot, even beyond the open-stream cap.
      for (let attempt = 0; attempt < 6; attempt++) {
        await expect(
          service.stream({ type: 'user', id: 'u', sessionId: 's' }, 'c', 'm', lastEventId),
        ).rejects.toMatchObject({
          httpStatus: 404,
          code: 'NOT_FOUND',
          message: 'Resource not found',
        });
      }
      expect(findMessage).toHaveBeenCalledWith('u', 'c', 'm');
      expect(read).not.toHaveBeenCalled();
    },
  );
});

/**
 * GoGo-BE#717 A-R2-09 — a losing writer took the committed terminal frame's
 * seq in the live buffer. The reader must still end with the committed
 * outcome instead of closing without a terminal event.
 */
describe('stream reader ends with the committed terminal frame (A-R2-09)', () => {
  it('a seq collision in the buffer does not swallow `done`', async () => {
    const buffer = new InMemoryFrameBuffer();
    const d = (seq: number, text: string): AssistantFrame => ({
      type: 'delta',
      seq,
      messageId: 'm',
      text,
    });
    // seq 2 in the buffer is the losing runner's delta, not the terminal.
    await buffer.append('m', [d(1, 'a '), d(2, 'late')], FAR);
    const base = {
      id: 'm',
      conversation_id: 'c',
      user_id: 'u',
      role: 'assistant',
      locale: 'vi',
      text: 'a ',
      cards: [],
      follow_ups: [],
      notice: null,
      error: null,
    };
    const finished = {
      ...base,
      status: 'stopped',
      frames: [d(1, 'a '), { type: 'done', seq: 2, messageId: 'm', status: 'stopped' }],
    } as unknown as MessageRow;
    let reads = 0;
    const repo = {
      db: { execute: async () => ({ rows: [] }) },
      findMessage: async () => {
        reads += 1;
        return reads === 1 ? ({ ...base, status: 'streaming', frames: null } as never) : finished;
      },
    };
    const service = new AssistantStreamService(
      repo as never,
      { hydrate: async () => [] } as never,
      buffer,
    );
    const out = await service.stream({ type: 'user', id: 'u', sessionId: 's' }, 'c', 'm', null);
    const events: SseMessage[] = [];
    await new Promise<void>((resolve) => {
      out.subscribe({ next: (e) => events.push(e), complete: () => resolve() });
    });
    const typed = events.filter(
      (e): e is { id?: string; type: string; data: string } => 'type' in e,
    );
    expect(typed[typed.length - 1]!.type).toBe('done');
    expect(typed.map((e) => Number(e.id))).toEqual([1, 2, 3]);
  }, 10_000);
});

describe('round-1 ordinary stream query budget', () => {
  it('classifies only once before the first of many buffered batches', async () => {
    const row = {
      id: 'm',
      role: 'assistant',
      status: 'streaming',
      text: '',
      trace: {},
      locale: 'en',
      created_at: new Date().toISOString(),
    };
    const findMessage = vi.fn(async () => row);
    const buffer = new InMemoryFrameBuffer();
    vi.spyOn(buffer, 'read').mockImplementation(async (_id, after) => [
      after < 5
        ? { type: 'delta', seq: after + 1, messageId: 'm', text: 'ordinary text' }
        : { type: 'done', seq: 6, messageId: 'm', status: 'complete' },
    ]);
    vi.spyOn(buffer, 'wait').mockResolvedValue();
    const service = new AssistantStreamService(
      { findMessage, db: {} } as never,
      {} as never,
      buffer,
    );
    const out = await service.stream({ type: 'user', id: 'u', sessionId: 's' }, 'c', 'm', null);
    const frames: SseMessage[] = [];
    await new Promise<void>((resolve) =>
      out.subscribe({ next: (e) => frames.push(e), complete: resolve }),
    );
    expect(frames).toHaveLength(6);
    expect(findMessage).toHaveBeenCalledTimes(2); // admission + one late-route classification
  });
});

it('retains periodic deletion checks after ordinary classification', async () => {
  vi.useFakeTimers();
  try {
    const row = {
      id: 'm',
      role: 'assistant',
      status: 'streaming',
      text: '',
      trace: { streamRoute: 'ordinary' },
      locale: 'en',
      created_at: new Date().toISOString(),
    };
    const findMessage = vi.fn().mockResolvedValueOnce(row).mockResolvedValue(null);
    const buffer = new InMemoryFrameBuffer();
    const stream = await new AssistantStreamService(
      { findMessage } as never,
      {} as never,
      buffer,
    ).stream({ type: 'user', id: 'u', sessionId: 's' }, 'c', 'm', null);
    let complete = false;
    stream.subscribe({
      complete: () => {
        complete = true;
      },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(complete).toBe(true);
    expect(findMessage).toHaveBeenCalledTimes(2); // admission + periodic lifecycle check
  } finally {
    vi.useRealTimers();
  }
});
