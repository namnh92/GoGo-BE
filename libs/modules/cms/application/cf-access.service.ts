import { Inject, Injectable, Optional } from '@nestjs/common';
import { createPublicKey } from 'node:crypto';
import { createVerifier } from 'fast-jwt';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type CloudflareAccessConfig } from '../../shared/config';

/**
 * The header Cloudflare Access puts on every request it lets through. Case is
 * irrelevant on the wire; Fastify lowercases incoming header names.
 */
export const CF_ACCESS_ASSERTION_HEADER = 'cf-access-jwt-assertion';

/** Optional override for the outbound key-set fetch. Bound only in tests. */
export const ACCESS_FETCH = Symbol('ACCESS_FETCH');

/** A verified human identity out of an Access assertion. */
export type AccessIdentity = {
  /** Address the upstream identity provider vouched for. */
  email: string;
  /** Access's own subject id. Stable per user per application. */
  subject: string;
};

type Jwk = { kid?: string; kty?: string; alg?: string } & Record<string, unknown>;

/**
 * How long a fetched key set is reused. Cloudflare rotates signing keys on its
 * own schedule and publishes the new one before retiring the old, so an hour
 * is comfortably inside the overlap.
 */
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Floor between two fetches triggered by an unrecognised `kid`. Without it a
 * forged token carrying a random `kid` is a free way to make this service
 * hammer Cloudflare: one outbound request per bogus token, from an endpoint
 * that by design accepts unauthenticated input.
 */
const JWKS_REFETCH_FLOOR_MS = 60 * 1000;

/**
 * #62 — CMS identity comes from Cloudflare Access.
 *
 * Access sits in front of the CMS hostname, federates the upstream identity
 * provider, enforces MFA there, and signs a short-lived JWT that the Worker
 * forwards to this API (`GoGo-CMS/worker/index.ts` passes every header
 * through). What arrives here is therefore a *claim about who*, and this
 * service is the only thing that decides whether to believe it.
 *
 * **The signature is the whole control.** `api-dev.gogo.id.vn` answers the
 * internet directly — it is not behind Access, and it cannot be, because the
 * mobile and web clients talk to it too. So `Cf-Access-Jwt-Assertion` is an
 * ordinary request header that anybody can set to anything. Reading the
 * `email` out of it without verifying, or trusting the plain
 * `Cf-Access-Authenticated-User-Email` header that Access also sends, would
 * let any caller name themselves any admin. Every check below exists because
 * skipping it hands over the console:
 *
 * - **Signature** against Cloudflare's published key set — the part no
 *   attacker can produce.
 * - **`aud`** must be this application's tag. A team usually fronts several
 *   applications, and Access signs all of them with the same keys. Without an
 *   `aud` check, a token minted for the lowest-value app in the account opens
 *   the CMS.
 * - **`iss`** must be this team's domain, so a token from somebody else's
 *   Cloudflare tenant is not accepted.
 * - **`exp` / `nbf`**, enforced by the verifier, so a captured assertion stops
 *   working.
 * - **`email` present** — service tokens authenticate to Access with
 *   `common_name` and no address. A machine identity has no place opening a
 *   console session that writes audit rows attributed to a person.
 */
@Injectable()
export class CloudflareAccessService {
  /**
   * `kid` → SPKI PEM. Stored as PEM rather than a `KeyObject` because fast-jwt
   * accepts only a string or buffer for an asymmetric key; handing it a
   * `KeyObject` fails at verification time with "The public key must be a
   * string or a buffer", which reads like a bad token rather than a bad type.
   */
  private keys = new Map<string, string>();
  private fetchedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: CloudflareAccessConfig,
    /**
     * Overridden in tests. Optional and token-bound because Nest resolves
     * constructor parameters by their emitted design type, and `typeof fetch`
     * emits as `Function` — a provider nothing registers, which would fail at
     * boot rather than in a test.
     */
    @Optional()
    @Inject(ACCESS_FETCH)
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  /**
   * Whether this deployment has been told which Access team and application to
   * trust. Both values are needed: a team domain without an audience tag would
   * accept every application in the account.
   */
  get configured(): boolean {
    return Boolean(this.config.CF_ACCESS_TEAM_DOMAIN && this.config.CF_ACCESS_AUD);
  }

  private get issuer(): string {
    return `https://${this.config.CF_ACCESS_TEAM_DOMAIN}`;
  }

  /**
   * Verifies an assertion and returns the identity it vouches for. Throws
   * `AppError` on every failure path, and never says *which* check failed:
   * the caller cannot fix a rejected token, and the difference between
   * "expired", "wrong audience" and "bad signature" is a probing aid.
   */
  async verify(assertion: string): Promise<AccessIdentity> {
    if (!this.configured) {
      throw AppError.serviceUnavailable(
        'ACCESS_SSO_NOT_CONFIGURED',
        'Single sign-on is not configured for this environment',
        false,
      );
    }

    const kid = kidOf(assertion);
    const key = await this.keyFor(kid);

    let claims: { email?: unknown; sub?: unknown };
    try {
      claims = createVerifier({
        key,
        algorithms: ['RS256'],
        allowedIss: this.issuer,
        allowedAud: this.config.CF_ACCESS_AUD,
        cache: false,
      })(assertion) as { email?: unknown; sub?: unknown };
    } catch {
      throw invalidAssertion();
    }

    const email = typeof claims.email === 'string' ? claims.email.trim() : '';
    const subject = typeof claims.sub === 'string' ? claims.sub : '';
    // A service token gets through Access with `common_name` and no address.
    // It is a valid Access identity and still the wrong kind of one here.
    if (!email || !subject) throw invalidAssertion();

    return { email, subject };
  }

  /**
   * Resolves a signing key, fetching the key set when the `kid` is unknown or
   * the cached copy has aged out. Concurrent callers share one fetch.
   */
  private async keyFor(kid: string): Promise<string> {
    const stale = Date.now() - this.fetchedAt > JWKS_TTL_MS;
    if (!this.keys.has(kid) || stale) {
      const canRefetch = stale || Date.now() - this.fetchedAt > JWKS_REFETCH_FLOOR_MS;
      if (canRefetch) await this.refresh();
    }
    const key = this.keys.get(kid);
    if (!key) throw invalidAssertion();
    return key;
  }

  private async refresh(): Promise<void> {
    this.inFlight ??= this.fetchKeys().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async fetchKeys(): Promise<void> {
    let payload: { keys?: Jwk[] };
    try {
      const response = await this.fetchImpl(`${this.issuer}/cdn-cgi/access/certs`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      payload = (await response.json()) as { keys?: Jwk[] };
    } catch {
      // Cloudflare being unreachable is an outage, not a bad credential. Saying
      // 401 here would send an operator hunting for a login problem that does
      // not exist — and the password + TOTP door still works meanwhile.
      throw AppError.serviceUnavailable(
        'ACCESS_KEYS_UNAVAILABLE',
        'Cannot reach the identity provider right now',
      );
    }

    const next = new Map<string, string>();
    for (const jwk of payload.keys ?? []) {
      // Only RSA signing keys: the verifier is pinned to RS256, and importing
      // a key it will never use just widens what a compromised key set can do.
      if (!jwk.kid || jwk.kty !== 'RSA') continue;
      try {
        const pem = createPublicKey({ key: jwk as never, format: 'jwk' }).export({
          type: 'spki',
          format: 'pem',
        });
        next.set(jwk.kid, pem as string);
      } catch {
        // One malformed entry must not discard the rest of the key set.
        continue;
      }
    }
    // An empty answer is kept out of the cache deliberately: overwriting good
    // keys with nothing would turn a bad response into a sign-in outage that
    // outlives it.
    if (next.size === 0) {
      throw AppError.serviceUnavailable(
        'ACCESS_KEYS_UNAVAILABLE',
        'Cannot reach the identity provider right now',
      );
    }
    this.keys = next;
    this.fetchedAt = Date.now();
  }
}

/**
 * Reads `kid` out of the JOSE header without verifying anything. Safe: the key
 * this selects is one Cloudflare published, and the signature is checked
 * against it immediately after. An attacker choosing a `kid` only chooses
 * which real key fails to verify their token.
 */
function kidOf(assertion: string): string {
  const [encodedHeader] = assertion.split('.');
  if (!encodedHeader) throw invalidAssertion();
  try {
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as {
      kid?: unknown;
      alg?: unknown;
    };
    // Refuse `alg` here as well as in the verifier. Defence in depth against
    // the classic confusion attacks — `none`, or an HS256 token signed with
    // the public key as its secret.
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
      throw invalidAssertion();
    }
    return header.kid;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidAssertion();
  }
}

/** One message for every rejection, so failures cannot be told apart. */
function invalidAssertion(): AppError {
  return AppError.unauthorized('ACCESS_ASSERTION_INVALID', 'Access assertion is not valid');
}
