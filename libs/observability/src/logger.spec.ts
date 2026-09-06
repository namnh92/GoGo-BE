import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redactUrl, requestSerializer } from './logger';

const SLUG = 'Af82XcAf82XcAf82XcAf82';

function capture() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, sink };
}

describe('request log redaction (LNK-BE-002 review finding 2)', () => {
  it('rewrites a share-link slug in the path, and nothing else', () => {
    expect(redactUrl(`/v1/share-links/${SLUG}`)).toBe('/v1/share-links/[redacted]');
    expect(redactUrl(`/v1/share-links/${SLUG}?x=1`)).toBe('/v1/share-links/[redacted]?x=1');
    expect(redactUrl('/v1/share-links')).toBe('/v1/share-links');
    expect(redactUrl('/v1/rooms/8d0d2f52-0000-4000-8000-000000000001')).toBe(
      '/v1/rooms/8d0d2f52-0000-4000-8000-000000000001',
    );
  });

  it('the req serializer keeps Fastify’s fields and redacts the URL', () => {
    expect(
      requestSerializer({
        method: 'DELETE',
        url: `/v1/share-links/${SLUG}`,
        host: 'api.test',
        ip: '10.0.0.1',
        socket: { remotePort: 4321 },
      }),
    ).toEqual({
      method: 'DELETE',
      url: '/v1/share-links/[redacted]',
      host: 'api.test',
      remoteAddress: '10.0.0.1',
      remotePort: 4321,
    });
  });

  it('a logged request never carries the slug — in the URL or as a field', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'info', name: 'test', destination: sink });
    logger.info(
      { req: { method: 'GET', url: `/v1/share-links/${SLUG}?x=1`, host: 'h', ip: '1.2.3.4' } },
      'incoming request',
    );
    logger.info({ slug: SLUG, inviteCode: SLUG, target: { inviteCode: SLUG } }, 'resolved');
    const out = lines.join('');
    expect(out).toContain('/v1/share-links/[redacted]?x=1');
    expect(out).not.toContain(SLUG);
    expect(out).toContain('"slug":"[redacted]"');
  });
});
