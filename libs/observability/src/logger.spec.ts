import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, errorSerializer, redactUrl, requestSerializer } from './logger';

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

describe('request log never records an exact position (ADM-022)', () => {
  it('redacts coordinate query values and keeps every other parameter', () => {
    expect(redactUrl('/v1/administrative/locate?lat=10.7769&lng=106.7009')).toBe(
      '/v1/administrative/locate?lat=[redacted]&lng=[redacted]',
    );
    expect(redactUrl('/v1/search?q=cafe&lat=10.77&lng=106.70&radiusM=5000')).toBe(
      '/v1/search?q=cafe&lat=[redacted]&lng=[redacted]&radiusM=5000',
    );
    expect(redactUrl('/v1/search?LAT=1&Latitude=2#x')).toBe(
      '/v1/search?LAT=[redacted]&Latitude=[redacted]#x',
    );
    expect(redactUrl('/v1/search?plateau=1&flat=2')).toBe('/v1/search?plateau=1&flat=2');
  });

  it('a logged locate request carries neither coordinate', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'info', name: 'test', destination: sink });
    logger.info(
      {
        req: {
          method: 'GET',
          url: '/v1/administrative/locate?lat=10.7769&lng=106.7009',
          host: 'h',
          ip: '1.2.3.4',
        },
      },
      'incoming request',
    );
    const out = lines.join('');
    expect(out).toContain('lat=[redacted]&lng=[redacted]');
    expect(out).not.toContain('10.7769');
    expect(out).not.toContain('106.7009');
  });
});

describe('logged errors never carry query parameters (#588)', () => {
  class DrizzleQueryError extends Error {
    readonly query = 'select id from places where ST_DWithin(geom, ST_MakePoint($1, $2), $3)';
    readonly params = ['106.700981', '10.776912', 5000];
    constructor() {
      super(
        'Failed query: select id from places where ST_DWithin(geom, ST_MakePoint($1, $2), $3)\nparams: 106.700981,10.776912,5000',
      );
      this.name = 'DrizzleQueryError';
    }
  }

  it('keeps the type, query and stack but not the bound values', () => {
    const serialized = errorSerializer(new DrizzleQueryError()) as Record<string, unknown>;
    expect(serialized.type).toBe('DrizzleQueryError');
    expect(serialized.query).toContain('ST_MakePoint($1, $2)');
    expect(serialized.params).toBe('[redacted]');
    expect(String(serialized.message)).toContain('params: [redacted]');
    expect(String(serialized.stack)).toContain('DrizzleQueryError');
    expect(JSON.stringify(serialized)).not.toContain('10.776912');
  });

  it('a logged query error carries neither coordinate', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'info', name: 'test', destination: sink });
    logger.error({ err: new DrizzleQueryError(), request_id: 'req-588' }, 'unhandled error');
    const out = lines.join('');
    expect(out).toContain('"request_id":"req-588"');
    expect(out).toContain('DrizzleQueryError');
    expect(out).not.toContain('10.776912');
    expect(out).not.toContain('106.700981');
  });

  it('passes a non-error value through unchanged', () => {
    expect(errorSerializer('boom')).toBe('boom');
  });
});

describe('request log and errors by shape (#588)', () => {
  it('redacts list-valued and encoded positions in the URL', () => {
    expect(
      redactUrl(
        '/v1/cms/places?bounds=10.70,106.60,10.85,106.80&next=%4010.7769%2C106.7009%2C17z&page=2',
      ),
    ).toBe('/v1/cms/places?bounds=[redacted]&next=%40[redacted]%2C17z&page=2');
  });

  it('a logged PostgreSQL error keeps its code and constraint but not the echoed row or geometry', () => {
    const cause = new Error('parse error - invalid geometry: POINT(106.700981 10.776912)');
    const err = Object.assign(
      new Error('null value in column "name" violates not-null constraint', { cause }),
      {
        code: '23502',
        constraint: 'places_name_not_null',
        detail: 'Failing row contains (a1, null, 10.776912, 106.700981).',
      },
    );
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'info', name: 'test', destination: sink });
    logger.error({ err, request_id: 'req-588' }, 'unhandled error');
    const out = lines.join('');
    expect(out).toContain('"code":"23502"');
    expect(out).toContain('places_name_not_null');
    expect(out).toContain('Failing row contains ([redacted]');
    expect(out).toContain('POINT([redacted])');
    expect(out).not.toContain('10.776912');
    expect(out).not.toContain('106.700981');
  });
});
