import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoopMetrics } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import type {
  InviteAttemptRepository,
  InviteAttemptTx,
  InviteContext,
  InviteReplay,
} from '../infrastructure/invite-attempt.repository';
import { CONTEXT_TTL_MS, InviteAttemptCrypto } from './invite-attempt-crypto';
import {
  InviteAttemptService,
  inviteIpBuckets,
  type InviteAttemptRequest,
} from './invite-attempt.service';

class MemoryRepo {
  now = new Date('2026-11-12T00:00:00.000Z');
  contexts = new Map<string, InviteContext>();
  replays = new Map<string, InviteReplay>();
  limit = vi.fn(async (_buckets: { key: string; limit: number }[]) => undefined);
  findProof = vi.fn(async (hash: string) => ({
    context: [...this.contexts.values()].find((c) => c.proofHash === hash),
    now: this.now,
  }));
  transaction = vi.fn(async <T>(key: string, work: (tx: InviteAttemptTx) => Promise<T>) =>
    work({
      now: this.now,
      findProof: async (hash) => [...this.contexts.values()].find((c) => c.proofHash === hash),
      findId: async (id) => this.contexts.get(id),
      replay: async () => this.replays.get(key),
      create: async (context, replay) => {
        this.contexts.set(context.id, context);
        this.replays.set(key, replay);
      },
    }),
  );
}
const origin = 'https://web.gogo.id.vn';
const browser = (): InviteAttemptRequest => ({
  ip: '203.0.113.1',
  key: randomUUID(),
  origin,
  fetchSite: 'same-site',
});
const mobile = (): InviteAttemptRequest => ({ ip: '203.0.113.1', key: randomUUID() });
let repo: MemoryRepo;
let crypto: InviteAttemptCrypto;
let service: InviteAttemptService;
let metrics: NoopMetrics;
beforeEach(() => {
  repo = new MemoryRepo();
  crypto = new InviteAttemptCrypto('test-managed-invite-key'.padEnd(48, 'x'));
  metrics = new NoopMetrics();
  service = new InviteAttemptService(
    repo as unknown as InviteAttemptRepository,
    crypto,
    { CORS_ORIGINS: [origin] },
    metrics,
  );
});

describe('I05 fixed-lifetime bootstrap and encrypted replay', () => {
  it('issues 256-bit mobile proof, hashes storage and encrypts replay atomically', async () => {
    const result = await service.bootstrap('MOBILE_HEADER', mobile());
    expect(result.body.contextToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.body.csrfToken).toBeUndefined();
    expect(result.cookie).toBeUndefined();
    expect(Date.parse(result.body.expiresAt) - repo.now.getTime()).toBe(CONTEXT_TTL_MS);
    const saved = [...repo.contexts.values()][0]!;
    expect(saved).toMatchObject({
      purpose: 'invite_attempts',
      proofHash: crypto.proofHash(result.body.contextToken!),
    });
    expect(JSON.stringify([...repo.contexts.values(), ...repo.replays.values()])).not.toContain(
      result.body.contextToken,
    );
  });
  it('replays lost first response with same token and original expiry; no new context', async () => {
    const request = mobile();
    const first = await service.bootstrap('MOBILE_HEADER', request);
    repo.now = new Date(repo.now.getTime() + 60_000);
    const retry = await service.bootstrap('MOBILE_HEADER', request);
    expect(retry.body).toEqual(first.body);
    expect(retry.maxAge).toBe(first.maxAge - 60);
    expect(repo.contexts.size).toBe(1);
  });
  it('existing valid proof survives IP/key/account changes without sliding renewal', async () => {
    const first = await service.bootstrap('MOBILE_HEADER', mobile());
    repo.now = new Date(repo.now.getTime() + 3600_000);
    const reused = await service.bootstrap('MOBILE_HEADER', {
      ...mobile(),
      ip: '198.51.100.9',
      headerProof: first.body.contextToken,
    });
    expect(reused.body).toEqual(first.body);
    expect(repo.contexts.size).toBe(1);
    expect(reused.maxAge).toBe(47 * 3600);
  });
  it('valid-proof bootstrap keys bind the concrete proof, not just IP', async () => {
    const a = await service.bootstrap('MOBILE_HEADER', mobile());
    const b = await service.bootstrap('MOBILE_HEADER', mobile());
    const request = mobile();
    await service.bootstrap('MOBILE_HEADER', { ...request, headerProof: a.body.contextToken });
    const keyA = repo.transaction.mock.calls.at(-1)![0];
    await service.bootstrap('MOBILE_HEADER', { ...request, headerProof: b.body.contextToken });
    expect(repo.transaction.mock.calls.at(-1)![0]).not.toBe(keyA);
  });
  it('first bootstrap keys bind IP; changing IP remains separately quota limited', async () => {
    const request = mobile();
    const a = await service.bootstrap('MOBILE_HEADER', request);
    const b = await service.bootstrap('MOBILE_HEADER', { ...request, ip: '198.51.100.9' });
    expect(b.body.contextToken).not.toBe(a.body.contextToken);
    expect(repo.limit).toHaveBeenCalledTimes(2);
    const keys = repo.limit.mock.calls[0]![0].map((b) => b.key);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    expect(keys.join()).not.toContain(request.ip);
  });
  it('same first IP/key with another transport returns 422', async () => {
    const request = mobile();
    await service.bootstrap('MOBILE_HEADER', request);
    await expect(
      service.bootstrap('BROWSER_COOKIE', { ...request, origin, fetchSite: 'same-site' }),
    ).rejects.toMatchObject({ httpStatus: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
  });
  it.each(['expired', 'revoked', 'purpose'])('never replays a %s context', async (kind) => {
    const request = mobile();
    await service.bootstrap('MOBILE_HEADER', request);
    const row = [...repo.contexts.values()][0]!;
    if (kind === 'expired') repo.now = row.expiresAt;
    if (kind === 'revoked') row.revokedAt = repo.now;
    if (kind === 'purpose') row.purpose = 'push_device';
    await expect(service.bootstrap('MOBILE_HEADER', request)).rejects.toMatchObject({
      httpStatus: 401,
      code: 'INVITE_CONTEXT_REQUIRED',
    });
    expect(repo.contexts.size).toBe(1);
  });
  it('tampered replay and replay swapped across resources fail closed', async () => {
    const requestA = mobile();
    await service.bootstrap('MOBILE_HEADER', requestA);
    await service.bootstrap('MOBILE_HEADER', mobile());
    const [a, b] = [...repo.replays.values()];
    a!.ciphertext = b!.ciphertext;
    await expect(service.bootstrap('MOBILE_HEADER', requestA)).rejects.toMatchObject({
      httpStatus: 503,
      code: 'INVITE_LOOKUP_UNAVAILABLE',
    });
  });
  it.each([undefined, 'not-a-uuid'])('requires a random UUID key (%s)', async (key) => {
    await expect(service.bootstrap('MOBILE_HEADER', { ...mobile(), key })).rejects.toMatchObject({
      httpStatus: 400,
      code: 'INVALID_IDEMPOTENCY_KEY',
    });
    expect(repo.contexts.size).toBe(0);
  });
});

describe('I05 CODE6 boundary before ticket/budget/lookup', () => {
  it.each([undefined, '', 'forged', 'A'.repeat(43)])(
    'uniformly rejects missing/malformed/forged proof %s',
    async (headerProof) => {
      const lookup = vi.fn();
      await expect(
        service.validateForCredential('CODE6', { ...mobile(), headerProof }).then(lookup),
      ).rejects.toMatchObject({ httpStatus: 401, code: 'INVITE_CONTEXT_REQUIRED' });
      expect(lookup).not.toHaveBeenCalled();
    },
  );
  it('rejects noncanonical base64url proof', async () => {
    await expect(
      service.validateForCredential('CODE6', { ...mobile(), headerProof: 'A'.repeat(42) + 'B' }),
    ).rejects.toMatchObject({ code: 'INVITE_CONTEXT_REQUIRED' });
    expect(repo.findProof).not.toHaveBeenCalled();
  });
  it.each(['expired', 'revoked', 'purpose', 'transport'])(
    'rejects %s proof before lookup',
    async (kind) => {
      const first = await service.bootstrap('MOBILE_HEADER', mobile());
      const row = [...repo.contexts.values()][0]!;
      if (kind === 'expired') repo.now = row.expiresAt;
      if (kind === 'revoked') row.revokedAt = repo.now;
      if (kind === 'purpose') row.purpose = 'push_device';
      if (kind === 'transport') row.transport = 'BROWSER_COOKIE';
      await expect(
        service.validateForCredential('CODE6', {
          ...mobile(),
          headerProof: first.body.contextToken,
        }),
      ).rejects.toMatchObject({ httpStatus: 401, code: 'INVITE_CONTEXT_REQUIRED' });
    },
  );
  it('accepts valid mobile proof, returning only internal context for downstream budget', async () => {
    const first = await service.bootstrap('MOBILE_HEADER', mobile());
    const result = await service.validateForCredential('CODE6', {
      ...mobile(),
      headerProof: first.body.contextToken,
    });
    expect(result?.id).toBe([...repo.contexts.keys()][0]);
  });
  it.each([undefined, 'TOKEN128'] as const)(
    'legacy %s omits all new fields and avoids context store/config entirely',
    async (type) => {
      const legacy = new InviteAttemptService(
        repo as unknown as InviteAttemptRepository,
        new InviteAttemptCrypto(''),
        {},
      );
      await expect(
        legacy.validateForCredential(type, { ip: '203.0.113.1' }),
      ).resolves.toBeUndefined();
      expect(repo.findProof).not.toHaveBeenCalled();
      expect(repo.limit).not.toHaveBeenCalled();
    },
  );
  it('missing configuration fails closed without touching storage', async () => {
    const missing = new InviteAttemptService(
      repo as unknown as InviteAttemptRepository,
      new InviteAttemptCrypto(''),
      {},
    );
    await expect(missing.bootstrap('MOBILE_HEADER', mobile())).rejects.toMatchObject({
      httpStatus: 503,
    });
    expect(repo.limit).not.toHaveBeenCalled();
  });
  it('DB failure is sanitized and recorded with bounded rejection labels', async () => {
    const increment = vi.spyOn(metrics, 'increment');
    repo.findProof.mockRejectedValue(new Error('SQL params: private-proof-marker'));
    await expect(
      service.validateForCredential('CODE6', { ...mobile(), headerProof: crypto.token() }),
    ).rejects.toMatchObject({ code: 'INVITE_LOOKUP_UNAVAILABLE', cause: undefined });
    expect(JSON.stringify(increment.mock.calls)).not.toContain('private-proof-marker');
    expect(increment).toHaveBeenCalledWith('invite_context_rejection_total', {
      operation: 'validate',
      result: 'INVITE_LOOKUP_UNAVAILABLE',
    });
  });
  it('quota refusals and in-flight retry hints survive the service', async () => {
    repo.limit.mockRejectedValueOnce(AppError.tooManyRequests('limited', 37));
    await expect(service.bootstrap('MOBILE_HEADER', mobile())).rejects.toMatchObject({
      httpStatus: 429,
      options: { retryAfterSeconds: 37 },
    });
    repo.transaction.mockRejectedValueOnce(
      new AppError('IDEMPOTENCY_IN_PROGRESS', 'busy', 409, { retryAfterSeconds: 1 }),
    );
    await expect(service.bootstrap('MOBILE_HEADER', mobile())).rejects.toMatchObject({
      httpStatus: 409,
      options: { retryAfterSeconds: 1 },
    });
  });
});

describe('I05 browser anti-CSRF bootstrap/transport', () => {
  it('never returns proof in JSON and reuses cookie only with separate CSRF', async () => {
    const request = browser();
    const first = await service.bootstrap('BROWSER_COOKIE', request);
    expect(first.body.contextToken).toBeUndefined();
    expect(first.body.csrfToken).toHaveLength(64);
    expect(first.cookie).toHaveLength(43);
    const replay = await service.bootstrap('BROWSER_COOKIE', request);
    expect(replay).toEqual(first);
    const withCookie = { ...browser(), cookieProof: first.cookie };
    await expect(service.bootstrap('BROWSER_COOKIE', withCookie)).rejects.toMatchObject({
      code: 'CSRF_FAILED',
      httpStatus: 403,
    });
    const reused = await service.bootstrap('BROWSER_COOKIE', {
      ...withCookie,
      csrf: first.body.csrfToken,
    });
    expect(reused).toEqual(first);
    await expect(
      service.validateForCredential('CODE6', { ...withCookie, csrf: first.body.csrfToken }),
    ).resolves.toMatchObject({ transport: 'BROWSER_COOKIE' });
  });
  it.each([
    { origin: undefined },
    { origin: 'null' },
    { origin: 'https://evil.example' },
    { origin: origin + '.evil.example' },
    { fetchSite: undefined },
    { fetchSite: 'cross-site' },
  ])('rejects first browser bootstrap with untrusted Origin/fetch metadata %j', async (change) => {
    await expect(
      service.bootstrap('BROWSER_COOKIE', { ...browser(), ...change }),
    ).rejects.toMatchObject({ httpStatus: 403, code: 'CSRF_FAILED' });
    expect(repo.contexts.size).toBe(0);
  });
  it('cannot select mobile mode in a browser to exfiltrate a proof', async () => {
    await expect(service.bootstrap('MOBILE_HEADER', browser())).rejects.toMatchObject({
      httpStatus: 403,
      code: 'CSRF_FAILED',
    });
  });
  it('rejects mixed/header-cookie substitution and wrong context CSRF', async () => {
    const web = await service.bootstrap('BROWSER_COOKIE', browser());
    const native = await service.bootstrap('MOBILE_HEADER', mobile());
    await expect(
      service.bootstrap('MOBILE_HEADER', { ...mobile(), cookieProof: web.cookie }),
    ).rejects.toMatchObject({ code: 'INVITE_CONTEXT_REQUIRED' });
    await expect(
      service.validateForCredential('CODE6', {
        ...browser(),
        cookieProof: web.cookie,
        headerProof: native.body.contextToken,
      }),
    ).rejects.toMatchObject({ code: 'INVITE_CONTEXT_REQUIRED' });
    await expect(
      service.validateForCredential('CODE6', {
        ...browser(),
        cookieProof: native.body.contextToken,
        csrf: web.body.csrfToken,
      }),
    ).rejects.toMatchObject({ code: 'INVITE_CONTEXT_REQUIRED' });
    await expect(
      service.validateForCredential('CODE6', {
        ...browser(),
        cookieProof: web.cookie,
        csrf: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'CSRF_FAILED' });
  });
});

it('normalizes independent IPv6 /64 and IPv4-mapped buckets', () => {
  expect(inviteIpBuckets('2001:db8::1')).toEqual(
    inviteIpBuckets('2001:0db8:0000:0000:0000:0000:0000:0001'),
  );
  expect(inviteIpBuckets('2001:db8::2').prefix).toBe(inviteIpBuckets('2001:db8::1').prefix);
  expect(inviteIpBuckets('2001:db8:0:1::1').prefix).not.toBe(inviteIpBuckets('2001:db8::1').prefix);
  expect(inviteIpBuckets('::ffff:192.0.2.1')).toEqual(inviteIpBuckets('192.0.2.1'));
});

describe('I05 read-only CSRF recovery', () => {
  it('recovers without key/CSRF; concurrent/stale-header calls preserve token, deadline and rows', async () => {
    const first = await service.bootstrap('BROWSER_COOKIE', browser());
    const transactions = repo.transaction.mock.calls.length;
    const request = { ...browser(), key: undefined, cookieProof: first.cookie };
    const results = await Promise.all([
      service.recoverCsrf(request),
      service.recoverCsrf({ ...request, csrf: 'stale' }),
    ]);
    expect(results).toEqual([first.body, first.body]);
    expect(repo.transaction).toHaveBeenCalledTimes(transactions);
    expect(repo.contexts.size).toBe(1);
    expect(repo.replays.size).toBe(1);
    expect(repo.limit.mock.calls[0]).toEqual(repo.limit.mock.calls[1]);
    expect(repo.limit.mock.calls[1]).toEqual(repo.limit.mock.calls[2]);
  });
  it.each([
    { origin: undefined },
    { origin: 'null' },
    { origin: 'https://evil.example' },
    { origin: 'https://sibling.gogo.id.vn' },
    { origin: origin + '.evil.example' },
    { origin: origin + ':444' },
    { origin: origin.replace('https:', 'http:') },
    { fetchSite: undefined },
    { fetchSite: 'cross-site' },
    { fetchSite: 'none' },
  ])('rejects origin/metadata before crypto/store access: %j', async (change) => {
    const assertConfigured = vi.spyOn(crypto, 'assertConfigured');
    await expect(service.recoverCsrf({ ...browser(), ...change })).rejects.toMatchObject({
      code: 'CSRF_FAILED',
    });
    expect(assertConfigured).not.toHaveBeenCalled();
    expect(repo.limit).not.toHaveBeenCalled();
    expect(repo.findProof).not.toHaveBeenCalled();
  });
  it('rejects even an allowlisted HTTP origin', async () => {
    const http = origin.replace('https:', 'http:');
    const insecure = new InviteAttemptService(repo as unknown as InviteAttemptRepository, crypto, {
      CORS_ORIGINS: [http],
    });
    await expect(insecure.recoverCsrf({ ...browser(), origin: http })).rejects.toMatchObject({
      code: 'CSRF_FAILED',
    });
  });
  it.each([undefined, '', 'malformed', 'A'.repeat(42) + 'B', 'A'.repeat(43)])(
    'rejects missing/malformed/forged proof %s',
    async (cookieProof) => {
      await expect(service.recoverCsrf({ ...browser(), cookieProof })).rejects.toMatchObject({
        code: 'INVITE_CONTEXT_REQUIRED',
        httpStatus: 401,
      });
      expect(repo.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['expired', 'revoked', 'purpose', 'transport'])('rejects %s context', async (kind) => {
    const first = await service.bootstrap('BROWSER_COOKIE', browser());
    const row = [...repo.contexts.values()][0]!;
    if (kind === 'expired') {
      repo.now = new Date(row.expiresAt.getTime() - 1);
      await expect(
        service.recoverCsrf({ ...browser(), cookieProof: first.cookie }),
      ).resolves.toEqual(first.body);
      repo.now = row.expiresAt;
    }
    if (kind === 'revoked') row.revokedAt = repo.now;
    if (kind === 'purpose') row.purpose = 'push_device';
    if (kind === 'transport') row.transport = 'MOBILE_HEADER';
    await expect(
      service.recoverCsrf({ ...browser(), cookieProof: first.cookie }),
    ).rejects.toMatchObject({ code: 'INVITE_CONTEXT_REQUIRED' });
  });
  it('rejects mobile cookie substitution and any header, including empty/mixed proof', async () => {
    const web = await service.bootstrap('BROWSER_COOKIE', browser());
    const native = await service.bootstrap('MOBILE_HEADER', mobile());
    for (const change of [
      { cookieProof: native.body.contextToken },
      { headerProof: native.body.contextToken },
      { headerProof: '', cookieProof: web.cookie },
      { headerProof: native.body.contextToken, cookieProof: web.cookie },
    ])
      await expect(service.recoverCsrf({ ...browser(), ...change })).rejects.toMatchObject({
        code: 'INVITE_CONTEXT_REQUIRED',
      });
  });
  it('recovered A token cannot authorize B or tampering; bootstrap and CODE6 retain CSRF checks', async () => {
    const a = await service.bootstrap('BROWSER_COOKIE', browser());
    const b = await service.bootstrap('BROWSER_COOKIE', browser());
    const recovered = await service.recoverCsrf({ ...browser(), cookieProof: a.cookie });
    for (const csrf of [undefined, '0'.repeat(64), recovered.csrfToken]) {
      const request = { ...browser(), cookieProof: b.cookie, csrf };
      await expect(service.bootstrap('BROWSER_COOKIE', request)).rejects.toMatchObject({
        code: 'CSRF_FAILED',
      });
      await expect(service.validateForCredential('CODE6', request)).rejects.toMatchObject({
        code: 'CSRF_FAILED',
      });
    }
  });
  it('sanitizes dependency errors, preserves quota hints, emits only bounded labels', async () => {
    const increment = vi.spyOn(metrics, 'increment');
    const first = await service.bootstrap('BROWSER_COOKIE', browser());
    const request = { ...browser(), cookieProof: first.cookie };
    repo.findProof.mockRejectedValueOnce(new Error('private-proof SQL marker'));
    await expect(service.recoverCsrf(request)).rejects.toMatchObject({
      code: 'INVITE_LOOKUP_UNAVAILABLE',
      httpStatus: 503,
      cause: undefined,
    });
    repo.limit.mockRejectedValueOnce(AppError.tooManyRequests('limited', 37));
    await expect(service.recoverCsrf(request)).rejects.toMatchObject({
      httpStatus: 429,
      options: { retryAfterSeconds: 37 },
    });
    await service.recoverCsrf(request);
    expect(increment).toHaveBeenCalledWith('invite_context_recovery_total', {
      result: 'recovered',
    });
    expect(increment).toHaveBeenCalledWith('invite_context_rejection_total', {
      operation: 'recover',
      result: 'INVITE_LOOKUP_UNAVAILABLE',
    });
    expect(JSON.stringify(increment.mock.calls)).not.toContain('private-proof');
    const unconfigured = new InviteAttemptService(
      repo as unknown as InviteAttemptRepository,
      new InviteAttemptCrypto(''),
      { CORS_ORIGINS: [origin] },
    );
    const count = repo.limit.mock.calls.length;
    await expect(unconfigured.recoverCsrf(request)).rejects.toMatchObject({ httpStatus: 503 });
    expect(repo.limit).toHaveBeenCalledTimes(count);
  });
});
