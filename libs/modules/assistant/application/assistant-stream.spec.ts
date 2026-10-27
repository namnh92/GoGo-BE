import { describe, expect, it } from 'vitest';
import { InMemoryFrameBuffer } from '../infrastructure/frame-buffer';
import { AssistantStreamService, type SseMessage } from './assistant-stream.service';
import type { MessageRow } from '../infrastructure/assistant.repository';
import type { AssistantFrame } from '../domain/assistant.types';

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
    await buffer.append('m', [d(1, 'a '), d(2, 'late')]);
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
