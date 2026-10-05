import { readFileSync } from 'node:fs';
import path from 'node:path';
import type * as Observability from '@gogo/observability';
import type * as SentryNode from '@sentry/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof SentryNode>()),
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
}));
vi.mock('@gogo/observability', async (importOriginal) => {
  const actual = await importOriginal<typeof Observability>();
  return { ...actual, sentryInitOptions: vi.fn(actual.sentryInitOptions) };
});

import * as Sentry from '@sentry/node';
import { sentryInitOptions } from '@gogo/observability';
import { captureWorkerError, fatalRejectionHandler, initWorkerSentry } from './sentry';

const DSN = 'https://public@o0.ingest.sentry.io/0';

/**
 * BE#675 — the worker initialises Sentry with the API's options (#588
 * redaction included), tagged from APP_ENV, and not at all without a DSN.
 */
describe('initWorkerSentry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not initialise Sentry when SENTRY_DSN is missing or empty', () => {
    expect(initWorkerSentry({ APP_ENV: 'dev' })).toBe(false);
    expect(initWorkerSentry({ APP_ENV: 'dev', SENTRY_DSN: '' })).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it.each(['dev', 'staging', 'prod'])(
    'initialises with the shared #588 options and environment=%s under NODE_ENV=production',
    (appEnv) => {
      expect(initWorkerSentry({ SENTRY_DSN: DSN, APP_ENV: appEnv, NODE_ENV: 'production' })).toBe(
        true,
      );
      expect(sentryInitOptions).toHaveBeenCalledExactlyOnceWith({
        dsn: DSN,
        environment: appEnv,
        // F-05: the worker ends the process itself; the SDK only captures.
        unhandledRejection: 'none',
        // F-03: no heartbeat URL configured here.
        secretUrls: [undefined, undefined, undefined],
      });
      expect(Sentry.init).toHaveBeenCalledExactlyOnceWith(
        vi.mocked(sentryInitOptions).mock.results[0]?.value,
      );
    },
  );

  it('hands every heartbeat URL to the shared redaction (F-03)', () => {
    initWorkerSentry({
      SENTRY_DSN: DSN,
      APP_ENV: 'dev',
      HEARTBEAT_URL_OUTBOX: 'https://hc-ping.com/a',
      HEARTBEAT_URL_INGEST: 'https://hc-ping.com/b',
      HEARTBEAT_URL_PRIVACY: 'https://hc-ping.com/c',
    });
    expect(vi.mocked(sentryInitOptions).mock.calls[0]?.[0].secretUrls).toEqual([
      'https://hc-ping.com/a',
      'https://hc-ping.com/b',
      'https://hc-ping.com/c',
    ]);
  });

  it('tags the job a failure came from', () => {
    const err = new Error('boom');
    captureWorkerError(err, 'gogo:worker:outbox');
    expect(Sentry.captureException).toHaveBeenCalledExactlyOnceWith(err, {
      tags: { periodic_job: 'gogo:worker:outbox' },
    });
  });
});

/**
 * BE#675 F-05 — an unhandled rejection ends the worker whatever its name. The
 * SDK skips its own handling (strict exit included) for the names in its
 * DEFAULT_IGNORES, `AbortError` among them, so the exit cannot live there.
 */
describe('fatalRejectionHandler', () => {
  it.each([
    ['a generic error', new Error('boom')],
    ['an AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['a non-error reason', 'nope'],
  ])('flushes, then exits 1 on %s', async (_label, reason) => {
    const order: string[] = [];
    const handler = fatalRejectionHandler({
      log: () => order.push('log'),
      flush: async () => void order.push('flush'),
      exit: (code) => void order.push(`exit ${code}`),
    });
    await handler(reason);
    expect(order).toEqual(['log', 'flush', 'exit 1']);
  });

  it('exits once when a second rejection lands during the flush', async () => {
    const exit = vi.fn();
    const handler = fatalRejectionHandler({ log: () => {}, flush: async () => {}, exit });
    await Promise.all([handler(new Error('a')), handler(new Error('b'))]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('still exits when the flush fails', async () => {
    const exit = vi.fn();
    const handler = fatalRejectionHandler({
      log: () => {},
      flush: async () => {
        throw new Error('network');
      },
      exit,
    });
    await handler(new Error('a'));
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

/**
 * main.ts runs `bootstrap()` on import, so its wiring is checked as source:
 * Sentry is up before bootstrap can fail, the runner gets the reporter, and a
 * failed bootstrap is captured and flushed before the process exits.
 */
describe('worker main wiring (BE#675)', () => {
  const main = readFileSync(path.join(__dirname, 'main.ts'), 'utf8');

  it('initialises Sentry before bootstrap runs', () => {
    const init = main.indexOf('initWorkerSentry(process.env)');
    expect(init).toBeGreaterThan(-1);
    expect(init).toBeLessThan(main.lastIndexOf('bootstrap().catch('));
  });

  it('installs the fatal rejection handler before bootstrap runs (F-05)', () => {
    const install = main.search(/process\.on\(\s*'unhandledRejection',\s*fatalRejectionHandler\(/);
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(main.lastIndexOf('bootstrap().catch('));
  });

  it('reads every validated interval inside bootstrap, after Sentry is up (F-04)', () => {
    const body = main.indexOf('async function bootstrap()');
    const calls = [...main.matchAll(/pollIntervalMs\('/g)].map((m) => m.index ?? -1);
    expect(calls.length).toBeGreaterThan(0);
    for (const at of calls) {
      // Defined as getters at module level; called only from bootstrap.
      const line = main.slice(main.lastIndexOf('\n', at) + 1, at);
      expect(line).toMatch(/=> $/);
    }
    for (const name of ['OUTBOX', 'INGEST', 'PLACE_REFRESH', 'MEDIA_CLEANUP']) {
      const read = main.indexOf(`const ${name}_POLL_MS = `);
      expect(read, name).toBeGreaterThan(body);
    }
  });

  it('hands the periodic runner the Sentry reporter', () => {
    expect(main).toMatch(/errors: \{ capture: captureWorkerError \}/);
  });

  it('captures and flushes a failed bootstrap before exiting', () => {
    const tail = main.slice(main.lastIndexOf('bootstrap().catch('));
    expect(tail).toMatch(
      /captureWorkerError\(err\)[\s\S]*await flushWorkerSentry\(\)[\s\S]*process\.exit\(1\)/,
    );
  });

  it('flushes on shutdown before the process exits', () => {
    const shutdown = main.slice(main.indexOf('const shutdown = async'));
    expect(shutdown).toMatch(/await flushWorkerSentry\(\)[\s\S]*process\.exit\(0\)/);
  });
});
