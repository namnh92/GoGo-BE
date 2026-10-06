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
