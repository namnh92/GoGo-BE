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
import { captureWorkerError, initWorkerSentry } from './sentry';

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
        // F-01: an unhandled rejection still ends the process, as before Sentry.
        unhandledRejection: 'strict',
      });
      expect(Sentry.init).toHaveBeenCalledExactlyOnceWith(
        vi.mocked(sentryInitOptions).mock.results[0]?.value,
      );
    },
  );

  it('tags the job a failure came from', () => {
    const err = new Error('boom');
    captureWorkerError(err, 'gogo:worker:outbox');
    expect(Sentry.captureException).toHaveBeenCalledExactlyOnceWith(err, {
      tags: { periodic_job: 'gogo:worker:outbox' },
    });
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
