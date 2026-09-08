import { generateKeyPairSync } from 'node:crypto';
import { createVerifier } from 'fast-jwt';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../shared/app-error';
import {
  IDENTITY_TOKEN_MAX_TTL_SECONDS,
  PushIdentityService,
  parseIdentitySigningKey,
} from './push-identity.service';

const APP_ID = '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

const user = { type: 'user', id: 'a3f1c2d4-0000-4000-8000-000000000001', sessionId: 's1' } as const;
const guest = { type: 'guest', id: 'g1', sessionId: 'g1', roomId: 'r1' } as const;

function service(overrides: Partial<Record<string, unknown>> = {}) {
  return new PushIdentityService({
    ONESIGNAL_APP_ID: APP_ID,
    ONESIGNAL_IDENTITY_VERIFICATION_KEY: PEM,
    ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS: 3_600,
    ...overrides,
  } as never);
}

/** A service whose provider call is a stub, so no test touches the network. */
function serviceWithFetch(
  fetchImpl: typeof fetch,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return new PushIdentityService(
    {
      ONESIGNAL_APP_ID: APP_ID,
      ONESIGNAL_IDENTITY_VERIFICATION_KEY: PEM,
      ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS: 3_600,
      ...overrides,
    } as never,
    undefined,
    fetchImpl,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseIdentitySigningKey', () => {
  it('accepts raw PEM, \\n-escaped PEM and base64 PEM as the same key', () => {
    const escaped = PEM.replace(/\n/g, '\\n');
    const b64 = Buffer.from(PEM).toString('base64');
    for (const raw of [PEM, escaped, b64]) {
      const key = parseIdentitySigningKey(raw);
      expect(key?.asymmetricKeyType).toBe('ec');
      expect(key?.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    }
  });

  it('empty means not configured; garbage and the wrong key type refuse at parse time', () => {
    expect(parseIdentitySigningKey('')).toBeNull();
    expect(parseIdentitySigningKey('   ')).toBeNull();
    expect(() => parseIdentitySigningKey('not-a-key')).toThrow(/PEM/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    expect(() => parseIdentitySigningKey(rsa)).toThrow(/EC P-256/);
    // The App API key is not an identity key and must not be mistaken for one.
    expect(() => parseIdentitySigningKey('os_v2_app_xxxxxxxxxxxx')).toThrow(/PEM/);
  });
});

describe('PushIdentityService (NTF-BE-008)', () => {
  it('signs an ES256 JWT for the authenticated user only, with the provider claim set', () => {
    const svc = service();
    expect(svc.available).toBe(true);
    const issued = svc.issue(user);
    expect(issued.externalId).toBe(user.id);

    const verify = createVerifier({ key: PUBLIC_PEM, algorithms: ['ES256'] });
    const claims = verify(issued.token) as {
      iss: string;
      exp: number;
      iat: number;
      identity: { external_id: string };
    };
    expect(claims.iss).toBe(APP_ID);
    expect(claims.identity).toEqual({ external_id: user.id });
    expect(claims.exp - claims.iat).toBe(IDENTITY_TOKEN_MAX_TTL_SECONDS);
    expect(new Date(issued.expiresAt).getTime()).toBe(claims.exp * 1_000);
    // Header carries only what the provider documents.
    const header = JSON.parse(Buffer.from(issued.token.split('.')[0]!, 'base64url').toString());
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT' });
  });

  it('caps the lifetime at one hour and floors it at a minute', () => {
    expect(service({ ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS: 86_400 }).ttlSeconds).toBe(3_600);
    expect(service({ ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS: 5 }).ttlSeconds).toBe(60);
    expect(service({ ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS: 900 }).ttlSeconds).toBe(900);
  });

  it('refuses guests: a device is bound to a person, never to a room session', () => {
    expect(() => service().issue(guest)).toThrow(AppError);
    try {
      service().issue(guest);
    } catch (err) {
      expect((err as AppError).code).toBe('USER_ONLY');
      expect((err as AppError).httpStatus).toBe(403);
    }
  });

  it('with no signing key the endpoint is unavailable, not permissive', () => {
    const svc = service({ ONESIGNAL_IDENTITY_VERIFICATION_KEY: '' });
    expect(svc.available).toBe(false);
    try {
      svc.issue(user);
      expect.unreachable();
    } catch (err) {
      expect((err as AppError).code).toBe('PUSH_IDENTITY_UNAVAILABLE');
      expect((err as AppError).httpStatus).toBe(503);
      expect((err as AppError).options.retryable).toBe(false);
    }
  });

  it('the token never appears in what the service records', () => {
    const increments: unknown[] = [];
    const svc = new PushIdentityService(
      {
        ONESIGNAL_APP_ID: APP_ID,
        ONESIGNAL_IDENTITY_VERIFICATION_KEY: PEM,
        ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS: 600,
      } as never,
      {
        increment: (...args: unknown[]) => increments.push(args),
        observe: () => undefined,
        time: async (_n, _l, fn) => fn(),
      },
    );
    const { token } = svc.issue(user);
    expect(JSON.stringify(increments)).not.toContain(token);
    expect(increments).toEqual([['push_identity_tokens_total', { result: 'issued' }]]);
  });
});

describe('confirmDeviceUnsubscribed (#160)', () => {
  const SUB = 'b3e26d4e-59dd-4eda-bd34-8261885ccefc';

  it('is not confirmed while the provider still has this device enabled', async () => {
    // The case the whole endpoint exists for: the device believes it logged
    // out, the provider disagrees, and the client must keep its session.
    const svc = serviceWithFetch(async () =>
      jsonResponse({ subscriptions: [{ id: SUB, enabled: true }] }),
    );
    await expect(svc.confirmDeviceUnsubscribed(user, SUB)).resolves.toEqual({ confirmed: false });
  });

  it('confirms once the provider reports it disabled', async () => {
    const svc = serviceWithFetch(async () =>
      jsonResponse({ subscriptions: [{ id: SUB, enabled: false }] }),
    );
    await expect(svc.confirmDeviceUnsubscribed(user, SUB)).resolves.toEqual({ confirmed: true });
  });

  it('confirms when the subscription no longer belongs to this user', async () => {
    // After a switch the device moves to the next account, so it is simply
    // absent here. Nothing of the caller's can deliver to it.
    const svc = serviceWithFetch(async () =>
      jsonResponse({ subscriptions: [{ id: 'someone-elses', enabled: true }] }),
    );
    await expect(svc.confirmDeviceUnsubscribed(user, SUB)).resolves.toEqual({ confirmed: true });
  });

  it('reads only the caller, and only reads', async () => {
    // The security argument, asserted rather than described: the URL carries
    // the actor's own id and the method is GET, so no body value can address
    // another person's devices and nothing can be mutated.
    let seenUrl = '';
    let seenMethod = '';
    const svc = serviceWithFetch(async (url, init) => {
      seenUrl = String(url);
      seenMethod = String((init as RequestInit).method);
      return jsonResponse({ subscriptions: [] });
    });
    await svc.confirmDeviceUnsubscribed(user, SUB);
    expect(seenUrl).toContain(`/users/by/external_id/${user.id}`);
    expect(seenUrl).toContain(`/apps/${APP_ID}/`);
    expect(seenMethod).toBe('GET');
  });

  it('authenticates with a Bearer identity token for that same user', async () => {
    // Identity Verification refuses the App API key on user reads, so this must
    // carry a JWT — and it must be the caller's, not a general credential.
    let auth = '';
    const svc = serviceWithFetch(async (_url, init) => {
      auth = String(
        (init as RequestInit).headers
          ? ((init as RequestInit).headers as Record<string, string>).authorization
          : '',
      );
      return jsonResponse({ subscriptions: [] });
    });
    await svc.confirmDeviceUnsubscribed(user, SUB);
    expect(auth.startsWith('Bearer ')).toBe(true);
    const verify = createVerifier({ key: PUBLIC_PEM, algorithms: ['ES256'] });
    const claims = verify(auth.slice('Bearer '.length)) as {
      iss: string;
      identity: { external_id: string };
    };
    expect(claims.iss).toBe(APP_ID);
    expect(claims.identity.external_id).toBe(user.id);
  });

  it('a provider that cannot be reached is retryable, never a false confirmation', async () => {
    const svc = serviceWithFetch(async () => {
      throw new Error('network down');
    });
    await expect(svc.confirmDeviceUnsubscribed(user, SUB)).rejects.toMatchObject({
      code: 'PUSH_UNSUBSCRIBE_UNCONFIRMED',
      options: { retryable: true },
    });
  });

  it('a provider error is not a confirmation either', async () => {
    const svc = serviceWithFetch(async () => jsonResponse({ errors: ['nope'] }, 500));
    await expect(svc.confirmDeviceUnsubscribed(user, SUB)).rejects.toBeInstanceOf(AppError);
  });

  it('a 200 it cannot parse is not a confirmation', async () => {
    const svc = serviceWithFetch(
      async () => new Response('<html>maintenance</html>', { status: 200 }),
    );
    await expect(svc.confirmDeviceUnsubscribed(user, SUB)).rejects.toMatchObject({
      code: 'PUSH_UNSUBSCRIBE_UNCONFIRMED',
    });
  });

  it('no user at that external id means nothing of theirs is subscribed', async () => {
    const svc = serviceWithFetch(async () => jsonResponse({}, 404));
    await expect(svc.confirmDeviceUnsubscribed(user, SUB)).resolves.toEqual({ confirmed: true });
  });

  it('guests have no push identity to confirm', async () => {
    const svc = serviceWithFetch(async () => jsonResponse({ subscriptions: [] }));
    await expect(svc.confirmDeviceUnsubscribed(guest, SUB)).rejects.toMatchObject({
      code: 'USER_ONLY',
    });
  });

  it('an environment with no signing key cannot confirm', async () => {
    const svc = serviceWithFetch(async () => jsonResponse({ subscriptions: [] }), {
      ONESIGNAL_IDENTITY_VERIFICATION_KEY: '',
    });
    await expect(svc.confirmDeviceUnsubscribed(user, SUB)).rejects.toMatchObject({
      code: 'PUSH_IDENTITY_UNAVAILABLE',
    });
  });
});
