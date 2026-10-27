import { describe, expect, it } from 'vitest';
import {
  AssistantOrchestrator,
  FirstTextDeadlineError,
  firstTextGuard,
} from './assistant-orchestrator.service';
import { newTurnState } from './turn-state';
import type { AssistantFrameInput } from '../domain/assistant.types';

/**
 * GoGo-BE#717 A-R-05/A-R-06 — the first-text deadline covers every stage, and
 * an abort is honoured at stage boundaries. No model is bound: the stages that
 * stall here are database reads, which is exactly what the deadline used not
 * to cover.
 */
const never = <T>() => new Promise<T>(() => undefined);

function orchestrator(stall: 'history' | 'none', deadlineMs: number) {
  const config = {
    ASSISTANT_FIRST_TEXT_TIMEOUT_MS: deadlineMs,
    ASSISTANT_JEV_TIMEOUT_MS: 1_000,
    ASSISTANT_MAX_OUTPUT_TOKENS: 100,
  };
  const repo = {
    history: () => (stall === 'history' ? never() : Promise.resolve([])),
    insertProposal: () => {
      throw new Error('a proposal must not be prepared');
    },
  };
  const taxonomy = {
    taxonomy: async () => ({ categories: [], occasions: [], moods: [], settings: [] }),
    labels: () => new Map<string, string>(),
  };
  const stub = {} as never;
  return new AssistantOrchestrator(
    config as never,
    repo as never,
    taxonomy as never,
    stub,
    stub,
    stub,
    stub,
    stub,
    null,
    null,
  );
}

const input = {
  messageId: 'm',
  ledgerId: 'l',
  conversationId: 'c',
  userId: 'u',
  text: 'Tìm quán cà phê yên tĩnh',
  locale: 'vi' as const,
  context: null,
};

describe('first-text deadline over the whole turn (A-R-05)', () => {
  it('a stalled database stage still answers deterministically within the deadline', async () => {
    const frames: AssistantFrameInput[] = [];
    const started = Date.now();
    const outcome = await orchestrator('history', 150).run(
      input,
      newTurnState(),
      { emit: async (f) => void frames.push(f) },
      new AbortController().signal,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(outcome.status).toBe('fallback');
    expect(frames[0]).toMatchObject({ type: 'delta' });
    expect(frames[1]).toMatchObject({ type: 'notice', notice: { reason: 'timeout' } });
  });

  it('the guard rejects at the deadline and on abort, and steps aside once released', async () => {
    const guard = firstTextGuard(Date.now() + 50, new AbortController().signal);
    await expect(guard.run(() => never())).rejects.toBeInstanceOf(FirstTextDeadlineError);
    guard.dispose();

    const controller = new AbortController();
    const g2 = firstTextGuard(Date.now() + 10_000, controller.signal);
    const pending = g2.run(() => never());
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    g2.dispose();

    const g3 = firstTextGuard(Date.now() + 10, new AbortController().signal);
    g3.release();
    await new Promise((r) => setTimeout(r, 30));
    await expect(g3.run(() => Promise.resolve(7))).resolves.toBe(7);
  });
});

describe('cancellation before the reply is composed (A-R-06)', () => {
  it('an abort that already fired stops the turn before any stage runs', async () => {
    const controller = new AbortController();
    controller.abort();
    const frames: AssistantFrameInput[] = [];
    await expect(
      orchestrator('none', 5_000).run(
        input,
        newTurnState(),
        { emit: async (f) => void frames.push(f) },
        controller.signal,
      ),
    ).rejects.toBeDefined();
    expect(frames).toEqual([]);
  });
});
