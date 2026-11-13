import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@gogo/observability';
import { NestPinoLogger } from './nest-pino-logger';

/**
 * GoGo-BE#680 review F-02 — a service's `new Logger(X.name).warn(...)` must
 * land in the structured stream, at the level it was written, under the
 * configured `LOG_LEVEL`, carrying the class as `context`.
 */
function capture(level = 'info') {
  const lines: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, nest: new NestPinoLogger(createLogger({ level, name: 't', destination: sink })) };
}

describe('NestPinoLogger', () => {
  it('redacts Fastify request logs even when onRequest rejects before validation', async () => {
    const { default: fastify } = await import('fastify');
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      name: 'rejected',
      destination: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    });
    const app = fastify({ loggerInstance: logger });
    let validated = false;
    app.addHook('onRequest', async (_req, reply) => {
      await reply.code(400).send();
    });
    app.addHook('preValidation', async () => {
      validated = true;
    });
    app.get('/v1/invite-attempt-contexts', async () => ({}));
    try {
      const response = await app.inject(
        '/v1/invite-attempt-contexts?%63ontextToken=private-rejected-proof&locale=vi',
      );
      expect(response.statusCode).toBe(400);
      expect(validated).toBe(false);
      expect(lines.join('')).toContain('incoming request');
      expect(lines.join('')).not.toContain('private-rejected-proof');
      expect(lines.join('')).toContain('locale=vi');
    } finally {
      await app.close();
    }
  });
  it('redacts actual serialized invite-proof messages and Error messages', () => {
    const { lines, nest } = capture();
    const proof = 'private-nest-invite-proof';
    nest.log(`contextToken=${proof}`, 'InviteService');
    nest.warn(
      `GET /v1/invite-attempt-contexts?%63ontextToken=${proof}&locale=vi rejected`,
      'InviteService',
    );
    nest.error(new Error(`csrfToken=${proof}`), 'InviteService');
    nest.log({ msg: `headerProof=${proof}` }, 'InviteService');
    expect(lines).toHaveLength(4);
    expect(JSON.stringify(lines)).not.toContain(proof);
    for (const line of lines) {
      expect(line.context).toBe('InviteService');
      expect(line.msg).toContain('[redacted]');
    }
    nest.log('q=public&notcontextToken=public', 'InviteService');
    expect(lines.at(-1)?.msg).toBe('q=public&notcontextToken=public');
  });

  it('writes a warning as a structured warn record with the Nest context', () => {
    const { lines, nest } = capture();
    nest.warn('cms.login refused: password door closed', 'AdminAuthService');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      context: 'AdminAuthService',
      msg: 'cms.login refused: password door closed',
    });
  });

  it('honours LOG_LEVEL: at warn, info is dropped and warn is kept', () => {
    const { lines, nest } = capture('warn');
    nest.log('boot detail', 'NestApplication');
    nest.warn('something to see', 'Svc');
    expect(lines.map((l) => l.level)).toEqual(['warn']);
  });

  it('maps every Nest level onto pino', () => {
    const { lines, nest } = capture('trace');
    nest.fatal('f');
    nest.error('e');
    nest.warn('w');
    nest.log('l');
    nest.debug('d');
    nest.verbose('v');
    expect(lines.map((l) => l.level)).toEqual(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
  });

  it('keeps a stack and an Error where the serializer expects them', () => {
    const { lines, nest } = capture();
    nest.error('failed', 'Error: boom\n    at here', 'Svc');
    expect(lines[0]).toMatchObject({ level: 'error', context: 'Svc', msg: 'failed' });
    expect(lines[0]?.stack).toContain('at here');

    nest.error(new Error('thrown'), 'Svc');
    expect(lines[1]).toMatchObject({ context: 'Svc', msg: 'thrown' });
    expect((lines[1]?.err as { message: string }).message).toBe('thrown');
  });

  it('spreads an object message into the record', () => {
    const { lines, nest } = capture();
    nest.log({ door: 'closed', msg: 'state' }, 'Svc');
    expect(lines[0]).toMatchObject({ door: 'closed', msg: 'state', context: 'Svc' });
  });
});

/**
 * The flow `main.ts` runs, end to end: `bufferLogs: true`, then the bridge,
 * then the flush. Without the flush Nest keeps buffering for the life of the
 * process and nothing a service logs ever arrives — the state the #680 review
 * found. This fails if either the `useLogger` or the `flushLogs` call goes.
 */
describe('Nest application with the bridge (as main.ts wires it)', () => {
  it('delivers a service warning written after boot to the structured stream', async () => {
    const { Logger, Module } = await import('@nestjs/common');
    const { NestFactory } = await import('@nestjs/core');
    const { FastifyAdapter } = await import('@nestjs/platform-fastify');
    const { lines, nest } = capture('warn');
    @Module({})
    class Empty {}
    const app = await NestFactory.create(Empty, new FastifyAdapter(), { bufferLogs: true });
    app.useLogger(nest);
    app.flushLogs();
    try {
      new Logger('AdminAuthService').warn('cms.login refused: password door closed');
      expect(lines).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          context: 'AdminAuthService',
          msg: 'cms.login refused: password door closed',
        }),
      );
    } finally {
      await app.close();
    }
  });
});
