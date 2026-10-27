import { describe, expect, it } from 'vitest';
import { AssistantFeedbackQueueService } from './assistant-feedback-queue.service';

/**
 * GoGo-BE#717 A-R-13 — the moderation queue's page cursor must not carry the
 * app's message id in a form a moderator can read.
 */
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';

function queue() {
  const params: unknown[][] = [];
  const db = {
    execute: async (query: { queryChunks?: unknown[] }) => {
      params.push(JSON.parse(JSON.stringify(query.queryChunks ?? [])) as unknown[]);
      const row = {
        message_id: MESSAGE_ID,
        conversation_id: '55555555-5555-4555-8555-555555555555',
        rating: 'down',
        reason: null,
        created_at: '2026-10-27T10:00:00.000000Z',
        status: 'complete',
        text: 'reply',
        cards: [],
        notice: null,
        model: null,
        sources: null,
        proposal_kinds: null,
      };
      return { rows: [row, { ...row, message_id: '66666666-6666-4666-8666-666666666666' }] };
    },
  };
  return {
    svc: new AssistantFeedbackQueueService(db as never, { AUTH_JWT_SECRET: 'x'.repeat(32) }),
    params,
  };
}

describe('feedback queue cursor (A-R-13)', () => {
  it('the next cursor does not reveal the message id, and still pages', async () => {
    const { svc, params } = queue();
    const page = await svc.list({ limit: 1 });
    const cursor = page.nextCursor!;
    expect(cursor).toBeTruthy();
    const decoded = Buffer.from(cursor, 'base64url').toString('latin1');
    expect(decoded).not.toContain(MESSAGE_ID);
    expect(cursor).not.toContain(MESSAGE_ID);
    await svc.list({ limit: 1, cursor });
    expect(JSON.stringify(params[params.length - 1])).toContain(MESSAGE_ID);
  });

  it('a forged or plain cursor is refused', async () => {
    const { svc } = queue();
    const plain = Buffer.from(JSON.stringify(['2026-10-27T10:00:00Z', MESSAGE_ID])).toString(
      'base64url',
    );
    await expect(svc.list({ limit: 1, cursor: plain })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });
});
