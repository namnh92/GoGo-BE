import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OneSignalPushAdapter, ONESIGNAL_MAX_ALIASES_PER_REQUEST } from './onesignal-push.adapter';
import {
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  ProviderUnavailableError,
  type UserNotification,
} from './ports';
import { resetBreakers } from './resilience';

const config = { appId: '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d', restApiKey: 'os_v2_app_test_key' };
const note: UserNotification = {
  headings: { en: 'GoGo', vi: 'GoGo' },
  contents: { en: 'plan_ready', vi: 'plan_ready' },
  data: { kind: 'plan_ready', roomId: 'room-1' },
  idempotencyKey: '5d1b2a30-9c4e-4f1a-8e2b-7c6d5e4f3a2b',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OneSignalPushAdapter', () => {
  beforeEach(() => resetBreakers());
  afterEach(() => vi.useRealTimers());

  it('refuses to construct without a credential — never a silent fake', () => {
    expect(() => new OneSignalPushAdapter({ appId: '', restApiKey: 'k' })).toThrow(
      ProviderConfigurationError,
    );
    expect(() => new OneSignalPushAdapter({ appId: config.appId, restApiKey: '' })).toThrow(
      ProviderConfigurationError,
    );
  });

  it('posts one create-notification call targeting external ids with the Key scheme', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'msg-1', external_id: note.idempotencyKey, errors: {} }),
    );
    const adapter = new OneSignalPushAdapter(config, undefined, fetchImpl as never);

    const result = await adapter.sendToUsers(['u1', 'u2', 'u1'], note);

    expect(result).toEqual({ providerMessageId: 'msg-1', unknownUserIds: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.onesignal.com/notifications?c=push');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Key os_v2_app_test_key');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      app_id: config.appId,
      include_aliases: { external_id: ['u1', 'u2'] },
      target_channel: 'push',
      headings: note.headings,
      contents: note.contents,
      data: note.data,
      idempotency_key: note.idempotencyKey,
    });
    // No device token, segment or filter ever appears in the payload.
    expect(body).not.toHaveProperty('include_subscription_ids');
    expect(body).not.toHaveProperty('included_segments');
  });

  it('reports ids the provider does not know instead of failing the batch', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'msg-2', errors: { invalid_aliases: { external_id: ['u2'] } } }),
    );
    const adapter = new OneSignalPushAdapter(config, undefined, fetchImpl as never);
    await expect(adapter.sendToUsers(['u1', 'u2'], note)).resolves.toEqual({
      providerMessageId: 'msg-2',
      unknownUserIds: ['u2'],
    });
  });

  it('a send nobody was subscribed for is accepted with no message id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: '', errors: ['All included players are not subscribed'] }),
    );
    const adapter = new OneSignalPushAdapter(config, undefined, fetchImpl as never);
    await expect(adapter.sendToUser('u1', note)).resolves.toEqual({
      providerMessageId: null,
      unknownUserIds: [],
    });
  });

  it('sends nothing for an empty target list', async () => {
    const fetchImpl = vi.fn();
    const adapter = new OneSignalPushAdapter(config, undefined, fetchImpl as never);
    await expect(adapter.sendToUsers([], note)).resolves.toEqual({
      providerMessageId: null,
      unknownUserIds: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('chunks above the provider limit with a distinct idempotency key per chunk', async () => {
    const keys: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      keys.push(JSON.parse(init.body as string).idempotency_key);
      return jsonResponse(200, { id: `msg-${keys.length}` });
    });
    const adapter = new OneSignalPushAdapter(config, undefined, fetchImpl as never);
    const ids = Array.from({ length: ONESIGNAL_MAX_ALIASES_PER_REQUEST + 1 }, (_, i) => `u${i}`);

    const result = await adapter.sendToUsers(ids, note);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.providerMessageId).toBe('msg-1');
    expect(keys[0]).toBe(note.idempotencyKey);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a refused credential is a configuration fault: no retry, no breaker', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { errors: ['forbidden'] }));
    const adapter = new OneSignalPushAdapter(config, undefined, fetchImpl as never);
    await expect(adapter.sendToUser('u1', note)).rejects.toBeInstanceOf(ProviderConfigurationError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a rejected payload is our bug, surfaced as an invalid request and not retried', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { errors: ['contents.en required'] }));
    const adapter = new OneSignalPushAdapter(config, undefined, fetchImpl as never);
    await expect(adapter.sendToUser('u1', note)).rejects.toBeInstanceOf(
      ProviderInvalidRequestError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('429 and 5xx are transient: retried, then reported as unavailable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(502, {}));
    const adapter = new OneSignalPushAdapter(config, undefined, fetchImpl as never);
    await expect(adapter.sendToUser('u1', note)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never puts the key anywhere but the header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, {}));
    const metrics = { increment: vi.fn(), observe: vi.fn() };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const adapter = new OneSignalPushAdapter(config, metrics, fetchImpl as never);
    const error = await adapter.sendToUser('u1', note).catch((e: unknown) => e as Error);
    const everything = JSON.stringify([
      String(error),
      (error as Error).message,
      metrics.increment.mock.calls,
      metrics.observe.mock.calls,
    ]);
    expect(everything).not.toContain(config.restApiKey);
    expect(metrics.increment).toHaveBeenCalledWith('push_provider_requests_total', { status: 500 });
  });
});
