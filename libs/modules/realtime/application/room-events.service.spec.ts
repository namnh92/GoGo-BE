import { PassThrough } from 'node:stream';
import { SseStream } from '@nestjs/core/router/sse-stream';
import { describe, expect, it } from 'vitest';
import { domainFrame, resyncFrame, type SseMessage } from './room-events.service';

const GEN = '0f8b2a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

/** Writes messages through the framework's real SSE serializer. */
async function wire(messages: SseMessage[]): Promise<string> {
  const stream = new SseStream();
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk: Buffer) => (text += chunk.toString()));
  stream.pipe(out);
  for (const message of messages) {
    await new Promise<void>((resolve) => stream.writeMessage(message as never, () => resolve()));
  }
  await new Promise((resolve) => setImmediate(resolve));
  return text;
}

const event = {
  generation: GEN,
  seq: 3,
  event: {
    event_id: '9b2f7a1c-0000-4000-8000-000000000001',
    event_type: 'vote.changed' as const,
    event_version: 1,
    occurred_at: '2026-10-03T00:00:00.000Z',
    actor_id: null,
    resource_type: 'room',
    resource_id: 'r',
    correlation_id: null,
    payload_schema_version: 1,
    payload: {},
  },
};

describe('SSE frames (ADR-0027, real NestJS SseStream)', () => {
  it('a domain event carries the opaque cursor as its id', async () => {
    const text = await wire([domainFrame(event)]);
    expect(text).toContain(`id: v2:${GEN}:3\n`);
    expect(text).toContain('event: vote.changed\n');
  });

  it('frames other than domain events carry no SSE id at all — never the framework counter', async () => {
    const text = await wire([
      resyncFrame('room-1', {
        reason: 'invalid_or_legacy_cursor',
        checkpoint: { generation: GEN, seq: 5 },
      }),
      { comment: 'ping' },
      resyncFrame('room-1', {
        reason: 'replay_unavailable',
        checkpoint: { generation: GEN, seq: 6 },
      }),
    ]);
    const frames = text.split('\n\n').filter((f) => f.trim());
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame).not.toMatch(/^id:/m);
    expect(frames[1]!.trim()).toBe(': ping');
    const data = JSON.parse(/^data: (.*)$/m.exec(frames[0]!)![1]!);
    expect(data).toEqual({
      roomId: 'room-1',
      reason: 'invalid_or_legacy_cursor',
      checkpoint: { cursor: `v2:${GEN}:5`, generation: GEN, seq: 5 },
    });
    expect(frames[0]).toMatch(/^event: resync$/m);
  });
});
