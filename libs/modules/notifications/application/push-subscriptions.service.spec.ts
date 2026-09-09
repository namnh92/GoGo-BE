import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../shared/app-error';
import { PushIdentityService } from './push-identity.service';
import { PushSubscriptionsService } from './push-subscriptions.service';

/**
 * NTF-BE-011 (#515) — registering a device is a claim about someone's
 * reachability, so it is checked against the provider before it is believed.
 */

const APP_ID = '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const user = { type: 'user', id: 'a3f1c2d4-0000-4000-8000-000000000001', sessionId: 's1' } as const;
const guest = { type: 'guest', id: 'g1', sessionId: 'g1', roomId: 'r1' } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Records what would have been written, so a refusal is visibly a no-write. */
function fakeDb() {
  const inserted: unknown[] = [];
  const db = {
    insert: () => ({
      values: (v: unknown) => {
        inserted.push(v);
        return {
          onConflictDoUpdate: () => ({
            returning: () =>
              Promise.resolve([{ platform: 'ios', lastConfirmedAt: new Date('2026-09-09T00:00:00Z') }]),
          }),
        };
      },
    }),
  };
  return { db, inserted };
}

function service(fetchImpl: typeof fetch) {
  const identity = new PushIdentityService(
    {
      ONESIGNAL_APP_ID: APP_ID,
      ONESIGNAL_IDENTITY_VERIFICATION_KEY: PEM,
      ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS: 3_600,
    } as never,
    undefined,
    fetchImpl,
  );
  const { db, inserted } = fakeDb();
  return { svc: new PushSubscriptionsService(db as never, identity), inserted };
}

describe('PushSubscriptionsService.register', () => {
  it('records a subscription the provider reports as enabled for the caller', async () => {
    const { svc, inserted } = service(
      vi.fn(async () =>
        jsonResponse({ subscriptions: [{ id: 'sub-1', enabled: true }] }),
      ) as unknown as typeof fetch,
    );

    const record = await svc.register(user, { platform: 'ios', subscriptionId: 'sub-1' });

    expect(record.platform).toBe('ios');
    expect(inserted).toEqual([
      { userId: user.id, platform: 'ios', subscriptionId: 'sub-1' },
    ]);
  });

  it('refuses a subscription id the provider does not list for this caller', async () => {
    // The abuse this closes: naming someone else's subscription id moves their
    // row onto the attacker's account, quietly removing them from every
    // campaign audience.
    const { svc, inserted } = service(
      vi.fn(async () =>
        jsonResponse({ subscriptions: [{ id: 'someone-elses', enabled: true }] }),
      ) as unknown as typeof fetch,
    );

    const error = await svc
      .register(user, { platform: 'ios', subscriptionId: 'sub-victim' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PUSH_SUBSCRIPTION_NOT_CONFIRMED');
    expect(inserted).toEqual([]);
  });

  it('refuses a subscription the caller owns but the provider has disabled', async () => {
    const { svc, inserted } = service(
      vi.fn(async () =>
        jsonResponse({ subscriptions: [{ id: 'sub-1', enabled: false }] }),
      ) as unknown as typeof fetch,
    );

    const error = await svc
      .register(user, { platform: 'ios', subscriptionId: 'sub-1' })
      .catch((e: unknown) => e);

    // Same code as "not yours": telling the two apart would make this a probe
    // for whether a given subscription id exists.
    expect((error as AppError).code).toBe('PUSH_SUBSCRIPTION_NOT_CONFIRMED');
    expect(inserted).toEqual([]);
  });

  it('refuses when the provider holds no user at this external id', async () => {
    const { svc, inserted } = service(
      vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    );

    const error = await svc
      .register(user, { platform: 'android', subscriptionId: 'sub-1' })
      .catch((e: unknown) => e);

    expect((error as AppError).code).toBe('PUSH_SUBSCRIPTION_NOT_CONFIRMED');
    expect(inserted).toEqual([]);
  });

  it('writes nothing, retryably, when the provider cannot be reached', async () => {
    const { svc, inserted } = service(
      vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    );

    const error = await svc
      .register(user, { platform: 'ios', subscriptionId: 'sub-1' })
      .catch((e: unknown) => e);

    expect((error as AppError).code).toBe('PUSH_SUBSCRIPTION_UNVERIFIED');
    expect((error as AppError).httpStatus).toBe(503);
    // An unverified claim in the audience is the failure this endpoint exists
    // to end, so an outage must not write one "optimistically".
    expect(inserted).toEqual([]);
  });

  it('writes nothing when the provider answers something unusable', async () => {
    const { svc, inserted } = service(
      vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
    );

    const error = await svc
      .register(user, { platform: 'ios', subscriptionId: 'sub-1' })
      .catch((e: unknown) => e);

    expect((error as AppError).code).toBe('PUSH_SUBSCRIPTION_UNVERIFIED');
    expect(inserted).toEqual([]);
  });

  it('refuses a guest before it asks the provider anything', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ subscriptions: [] }));
    const { svc, inserted } = service(fetchImpl as unknown as typeof fetch);

    const error = await svc
      .register(guest as never, { platform: 'ios', subscriptionId: 'sub-1' })
      .catch((e: unknown) => e);

    expect((error as AppError).code).toBe('USER_ONLY');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });
});
