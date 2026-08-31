import { describe, expect, it, vi } from 'vitest';
import { createSigner } from 'fast-jwt';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { AppError } from '../../shared/app-error';
import { CloudflareAccessService } from './cf-access.service';

const TEAM = 'gogo.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const AUD = 'a'.repeat(64);
const KID = 'key-1';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwks(publicKey: KeyObject, kid = KID) {
  return { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] };
}

function sign(
  claims: Record<string, unknown>,
  opts: { key?: KeyObject; kid?: string; expiresIn?: number } = {},
) {
  return createSigner({
    key: (opts.key ?? pair.privateKey).export({ type: 'pkcs8', format: 'pem' }) as string,
    algorithm: 'RS256',
    header: { kid: opts.kid ?? KID, alg: 'RS256' },
    expiresIn: opts.expiresIn ?? 60_000,
  })({ iss: ISSUER, aud: AUD, sub: 'sub-1', email: 'ops@gogo.id.vn', ...claims });
}

function serviceWith(
  body: unknown = jwks(pair.publicKey),
  config = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD },
) {
  const fetchImpl = vi.fn(async () => Response.json(body));
  return {
    fetchImpl,
    service: new CloudflareAccessService(config, fetchImpl as unknown as typeof fetch),
  };
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    return (error as AppError).code;
  }
  throw new Error('expected a rejection');
}

describe('CloudflareAccessService', () => {
  it('accepts an assertion signed by the published key', async () => {
    const { service } = serviceWith();
    await expect(service.verify(sign({}))).resolves.toEqual({
      email: 'ops@gogo.id.vn',
      subject: 'sub-1',
    });
  });

  /*
   * The load-bearing test. `api-dev.gogo.id.vn` answers the internet directly,
   * so `Cf-Access-Jwt-Assertion` is a header anyone can set. If a token signed
   * by a key Cloudflare never published were accepted, naming yourself any
   * admin would be a one-line curl.
   */
  it('refuses an assertion signed by a key Cloudflare did not publish', async () => {
    const { service } = serviceWith();
    expect(await codeOf(service.verify(sign({}, { key: other.privateKey })))).toBe(
      'ACCESS_ASSERTION_INVALID',
    );
  });

  /*
   * A Cloudflare account usually fronts several applications and signs them all
   * with the same keys. Without the audience check, a token minted for the
   * lowest-value app in the account — a status page, a staging preview — opens
   * the console.
   */
  it('refuses an assertion minted for another application in the same team', async () => {
    const { service } = serviceWith();
    expect(await codeOf(service.verify(sign({ aud: 'b'.repeat(64) })))).toBe(
      'ACCESS_ASSERTION_INVALID',
    );
  });

  it('refuses an assertion from another Cloudflare tenant', async () => {
    const { service } = serviceWith();
    expect(await codeOf(service.verify(sign({ iss: 'https://evil.cloudflareaccess.com' })))).toBe(
      'ACCESS_ASSERTION_INVALID',
    );
  });

  it('refuses an expired assertion', async () => {
    const { service } = serviceWith();
    expect(await codeOf(service.verify(sign({}, { expiresIn: -1000 })))).toBe(
      'ACCESS_ASSERTION_INVALID',
    );
  });

  /*
   * `alg: none` and the RS256→HS256 confusion attack both work by getting the
   * verifier to accept an algorithm the issuer never used. The header is
   * screened before a key is even selected.
   */
  it.each(['none', 'HS256'])('refuses an assertion declaring alg=%s', async (alg) => {
    const { service } = serviceWith();
    const header = Buffer.from(JSON.stringify({ alg, kid: KID })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUD })).toString('base64url');
    expect(await codeOf(service.verify(`${header}.${payload}.`))).toBe('ACCESS_ASSERTION_INVALID');
  });

  /*
   * A service token authenticates to Access with `common_name` and no address.
   * It is a valid Access identity and the wrong kind of one: a console session
   * writes audit rows attributed to a person.
   */
  it('refuses a service token, which carries no email', async () => {
    const { service } = serviceWith();
    expect(await codeOf(service.verify(sign({ email: undefined, common_name: 'ci' })))).toBe(
      'ACCESS_ASSERTION_INVALID',
    );
  });

  it('refuses a malformed assertion without reaching the network', async () => {
    const { service, fetchImpl } = serviceWith();
    expect(await codeOf(service.verify('not-a-jwt'))).toBe('ACCESS_ASSERTION_INVALID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports 503, not a credential failure, when Cloudflare is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const service = new CloudflareAccessService(
      { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD },
      fetchImpl as unknown as typeof fetch,
    );
    const error = await service.verify(sign({})).catch((e: AppError) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('ACCESS_KEYS_UNAVAILABLE');
    expect((error as AppError).httpStatus).toBe(503);
  });

  /*
   * An empty key set must not overwrite a good one: a bad response would
   * otherwise turn a momentary blip into a sign-in outage that outlives it.
   */
  it('keeps the cached key set when a refresh returns nothing usable', async () => {
    vi.useFakeTimers();
    try {
      const responses: unknown[] = [jwks(pair.publicKey), { keys: [] }];
      let call = 0;
      const fetchImpl = vi.fn(async () => Response.json(responses[Math.min(call++, 1)]));
      const service = new CloudflareAccessService(
        { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD },
        fetchImpl as unknown as typeof fetch,
      );
      const long = { expiresIn: 10 * 60_000 };
      await expect(service.verify(sign({}, long))).resolves.toMatchObject({
        email: 'ops@gogo.id.vn',
      });

      vi.advanceTimersByTime(61_000); // past the refetch floor
      expect(await codeOf(service.verify(sign({}, { ...long, kid: 'unknown' })))).toBe(
        'ACCESS_KEYS_UNAVAILABLE',
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      // The good key survived the bad answer.
      await expect(service.verify(sign({}, long))).resolves.toMatchObject({
        email: 'ops@gogo.id.vn',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * The refetch floor throttles forged kids; it must not also make a real key
   * rotation permanent. Cloudflare publishes the new key before retiring the
   * old, so the worst case is one floor's worth of rejected sign-ins.
   */
  it('picks up a rotated signing key once the refetch floor has passed', async () => {
    vi.useFakeTimers();
    try {
      const responses: unknown[] = [jwks(pair.publicKey), jwks(other.publicKey, 'key-2')];
      let call = 0;
      const fetchImpl = vi.fn(async () => Response.json(responses[Math.min(call++, 1)]));
      const service = new CloudflareAccessService(
        { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD },
        fetchImpl as unknown as typeof fetch,
      );
      const rotated = { key: other.privateKey, kid: 'key-2', expiresIn: 10 * 60_000 };
      await expect(service.verify(sign({}, { expiresIn: 10 * 60_000 }))).resolves.toMatchObject({
        email: 'ops@gogo.id.vn',
      });

      // Inside the floor the new key is not fetched, so the new token fails.
      expect(await codeOf(service.verify(sign({}, rotated)))).toBe('ACCESS_ASSERTION_INVALID');
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);
      await expect(service.verify(sign({}, rotated))).resolves.toMatchObject({
        email: 'ops@gogo.id.vn',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * This endpoint accepts unauthenticated input by design, so one outbound
   * request per forged `kid` would make it a free amplifier against Cloudflare.
   */
  it('does not fetch the key set once per forged kid', async () => {
    const { service, fetchImpl } = serviceWith();
    await service.verify(sign({}));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      await codeOf(service.verify(sign({}, { kid: `forged-${i}` })));
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('answers 503 when the environment has no Access configured', async () => {
    const { service, fetchImpl } = serviceWith(undefined, {
      CF_ACCESS_TEAM_DOMAIN: '',
      CF_ACCESS_AUD: '',
    });
    expect(service.configured).toBe(false);
    const error = await service.verify(sign({})).catch((e: AppError) => e);
    expect((error as AppError).code).toBe('ACCESS_SSO_NOT_CONFIGURED');
    expect((error as AppError).httpStatus).toBe(503);
    // Not retryable: a missing configuration does not clear on its own, and a
    // client retrying it generates load instead of a support ticket.
    expect((error as AppError).options.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
