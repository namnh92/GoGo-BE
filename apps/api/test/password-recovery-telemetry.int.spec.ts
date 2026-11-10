import { Writable } from 'node:stream';
import * as Sentry from '@sentry/node';
import { sentryInitOptions } from '@gogo/observability';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  RecoveryMailSender,
  type RecoveryMailSink,
} from '../../../libs/modules/identity/infrastructure/recovery-mail';
import { RATE_LIMIT_STORE } from '../../../libs/modules/identity/presentation/rate-limit.service';
import type { RecoveryResponse } from '../../../libs/modules/identity/application/password-recovery.service';
import {
  COMPLETE,
  REQUEST,
  NEW_PASSWORD,
  OLD_PASSWORD,
  RECOVERY_KEY,
  JWT_KEY,
  crypto,
  recoveryFixture,
  type RecoveryFixture,
  type Grant,
} from './support/password-recovery-fixture';

const lines: Record<string, unknown>[] = [];
const envelopes: unknown[] = [];
const sink = new Writable({
  write(chunk, _encoding, callback) {
    lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
    callback();
  },
});
let f: RecoveryFixture;
let telemetry: NestFastifyApplication;
let origin: string;
beforeAll(async () => {
  // Same HTTP instrumentation/options as sentry-request.spec.ts. Only the
  // transport changes; requests below traverse a real listening application.
  Sentry.init({
    ...sentryInitOptions({ dsn: 'https://public@o0.ingest.sentry.io/0', environment: 'test' }),
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  f = await recoveryFixture();
  // Test mode is intentionally separate from the Redis/cached-store fixture:
  // production JSON logging honors logDestination; development pretty does not.
  telemetry = await f.startApp({ telemetry: sink });
  await telemetry.listen(0, '127.0.0.1');
  origin = await telemetry.getUrl();
});
afterAll(async () => {
  await f?.close();
  await Sentry.close(2000);
});

function events() {
  return envelopes.flatMap((envelope) =>
    (
      envelope as [
        unknown,
        [
          { type: string },
          {
            extra?: { request_id?: string };
            request?: { data?: unknown; cookies?: unknown; method?: string; url?: string };
          },
        ][],
      ]
    )[1]
      .filter(([header]) => header.type === 'event')
      .map(([, event]) => event),
  );
}

describe('I-5 recovery telemetry on real HTTP requests', () => {
  it('captures correlated success, invalid proof, throttle, replay logs and a flushed 5xx Sentry event without actual credentials, including wrapped database causes', async () => {
    const email = 'telemetry-recovery-private@example.test';
    const register = await fetch(`${origin}/v1/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'recovery-telemetry-register',
      },
      body: JSON.stringify({ email, password: OLD_PASSWORD, displayName: 'Telemetry' }),
    });
    expect(register.status).toBe(201);
    const grant = (await register.json()) as Grant;
    const cookies = register.headers.getSetCookie().map((c) => c.split(';')[0]!);
    const secrets = [
      email,
      OLD_PASSWORD,
      NEW_PASSWORD,
      grant.accessToken,
      grant.refreshToken,
      RECOVERY_KEY,
      JWT_KEY,
      ...cookies.map((c) => c.slice(c.indexOf('=') + 1)),
    ];
    const requestIds: string[] = [];
    async function call(path: string, body: object, id: string, key: string) {
      requestIds.push(id);
      return fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': id,
          'idempotency-key': key,
          authorization: `Bearer ${grant.accessToken}`,
          cookie: cookies.join('; '),
        },
        body: JSON.stringify(body),
      });
    }
    function clearMemoryQuotas() {
      // No global fake clock and no fake persistence: reset only the separate
      // telemetry app's in-memory quota windows between explicitly aged cases.
      (telemetry.get(RATE_LIMIT_STORE) as { buckets: Map<string, number[]> }).buckets.clear();
    }
    const missing = 'not-found-telemetry-private@example.test';
    secrets.push(missing);
    const notFound = await call(
      REQUEST,
      { email: missing },
      'recovery-telemetry-not-found',
      'telemetry-not-found',
    );
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toMatchObject({
      code: 'RECOVERY_ACCOUNT_NOT_FOUND',
      message: 'Tài khoản không tồn tại',
      retryable: false,
    });
    const accepted = await call(
      REQUEST,
      { email },
      'recovery-telemetry-success',
      'telemetry-request',
    );
    expect(accepted.status).toBe(202);
    const originalBody = (await accepted.json()) as RecoveryResponse;
    expect(Object.keys(originalBody).sort()).toEqual([
      'challengeId',
      'expiresAt',
      'resendAvailableAt',
    ]);
    const proof = (telemetry.get(RecoveryMailSender) as RecoveryMailSink).sent.find(
      (m) => m.email === email,
    )!;
    expect(proof).toBeDefined();
    secrets.push(proof.code);
    const input = {
      email,
      challengeId: proof.challengeId,
      code: proof.code,
      password: NEW_PASSWORD,
    };
    const invalid = await call(
      COMPLETE,
      { ...input, code: proof.code === '000000' ? '111111' : '000000' },
      'recovery-telemetry-invalid',
      'telemetry-invalid',
    );
    expect(invalid.status).toBe(400);
    await invalid.text();
    const throttle = await call(
      REQUEST,
      { email },
      'recovery-telemetry-throttle',
      'telemetry-request',
    );
    expect(throttle.status).toBe(429);
    await throttle.text();
    clearMemoryQuotas();
    await f.allowResend(email);
    const requestReplay = await call(
      REQUEST,
      { email },
      'recovery-telemetry-request-replay',
      'telemetry-request',
    );
    expect(requestReplay.status).toBe(202);
    // Durable JSON replay preserves every field/value, not jsonb key order.
    expect(await requestReplay.json()).toStrictEqual(originalBody);
    const success = await call(
      COMPLETE,
      input,
      'recovery-telemetry-complete',
      'telemetry-complete',
    );
    expect(success.status).toBe(204);
    const replay = await call(
      COMPLETE,
      input,
      'recovery-telemetry-completion-replay',
      'telemetry-complete',
    );
    expect(replay.status).toBe(204);

    clearMemoryQuotas();
    await f.allowResend(email);
    // PostgreSQL raises credential-bearing diagnostics. Drizzle wraps that
    // cause; the recovery boundary must discard it before logging/reporting.
    const undo = await f.failWrite(
      'password_recovery_challenges',
      `NEW.email_digest = '${crypto.digest('email', email)}'`,
      JSON.stringify(secrets),
    );
    try {
      const failed = await call(
        REQUEST,
        { email },
        'recovery-telemetry-failure',
        'telemetry-failure',
      );
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({
        code: 'RECOVERY_UNAVAILABLE',
        request_id: 'recovery-telemetry-failure',
      });
    } finally {
      await undo();
    }
    expect(await Sentry.flush(2000)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const id of requestIds) {
      expect(
        lines.some((line) => line.reqId === id || line.request_id === id),
        id,
      ).toBe(true);
      expect(
        lines.some((line) => line.reqId === id && line.msg === 'request completed'),
        id,
      ).toBe(true);
    }
    const reported = events().filter(
      (event) => event.extra?.request_id === 'recovery-telemetry-failure',
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]!.request?.method).toBe('POST');
    expect(reported[0]!.request?.url).toContain(REQUEST);
    expect(reported[0]!.request?.data).toBeUndefined();
    expect(reported[0]!.request?.cookies).toBeUndefined();
    for (const payload of [JSON.stringify(lines), JSON.stringify(envelopes)]) {
      for (const secret of secrets) {
        expect(secret.length).toBeGreaterThan(0);
        expect(payload).not.toContain(secret);
        expect(payload).not.toContain(encodeURIComponent(secret));
      }
    }
  });
});
