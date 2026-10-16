import type * as NestCore from '@nestjs/core';
import type * as SentryNode from '@sentry/node';
import { describe, expect, it, vi } from 'vitest';
import type * as EnvModule from './config/env';

const STOP = new Error('stop after Sentry.init');
const init = vi.fn();
let env: Record<string, string> = {};

vi.mock('@sentry/node', async (importOriginal) => ({
  ...(await importOriginal<typeof SentryNode>()),
  init: (options: unknown) => init(options),
}));
// createApp is exercised only up to Sentry.init; the Nest app is never built.
vi.mock('@nestjs/core', async (importOriginal) => ({
  ...(await importOriginal<typeof NestCore>()),
  NestFactory: { create: () => Promise.reject(STOP) },
}));
vi.mock('./app.module', () => ({ AppModule: class {} }));
vi.mock('./config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  // A valid workstation config, with the deployment-shaped fields under test on top.
  const base = actual.loadEnv({
    DATABASE_URL: 'postgres://gogo:gogo@localhost:5432/gogo',
    REDIS_URL: 'redis://localhost:6379',
  });
  return { ...actual, loadEnv: () => ({ ...base, ...env }) };
});

import { createApp } from './main';

/**
 * #674 — every deployed environment runs the production build (NODE_ENV=production),
 * so the Sentry environment must name the deployment (APP_ENV), or DEV errors land
 * in the shared project tagged as production.
 */
describe('Sentry environment (#674)', () => {
  it.each([
    ['dev', 'dev'],
    ['staging', 'staging'],
    ['prod', 'prod'],
  ])('APP_ENV=%s with NODE_ENV=production tags events %s', async (appEnv, expected) => {
    init.mockClear();
    env = {
      NODE_ENV: 'production',
      APP_ENV: appEnv,
      SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
    };

    await expect(createApp()).rejects.toBe(STOP);

    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0]?.[0]).toMatchObject({ environment: expected });
  });

  // #697 — the release names the deployed commit, and is absent without one.
  const SHA = 'f55b749f55b749f55b749f55b749f55b749f55b7';
  it.each([
    [SHA, `gogo-be@${SHA}`],
    ['', undefined],
    [undefined, undefined],
  ])('GOGO_REVISION=%s → release %s', async (revision, expected) => {
    init.mockClear();
    env = {
      NODE_ENV: 'production',
      APP_ENV: 'dev',
      SENTRY_DSN: 'https://public@o0.ingest.sentry.io/0',
    };
    const saved = process.env.GOGO_REVISION;
    if (revision === undefined) delete process.env.GOGO_REVISION;
    else process.env.GOGO_REVISION = revision;
    try {
      await expect(createApp()).rejects.toBe(STOP);
    } finally {
      if (saved === undefined) delete process.env.GOGO_REVISION;
      else process.env.GOGO_REVISION = saved;
    }

    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0]?.[0] as Record<string, unknown>;
    if (expected) expect(options.release).toBe(expected);
    else expect(options).not.toHaveProperty('release');
  });

  it('does not initialise Sentry without a DSN', async () => {
    init.mockClear();
    env = { NODE_ENV: 'production', APP_ENV: 'dev', SENTRY_DSN: '' };

    await expect(createApp()).rejects.toBe(STOP);

    expect(init).not.toHaveBeenCalled();
  });
});
