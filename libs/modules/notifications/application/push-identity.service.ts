import { Inject, Injectable, Optional } from '@nestjs/common';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { createSigner } from 'fast-jwt';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type PushIdentityConfig } from '../../shared/config';
import { ONESIGNAL_API_BASE } from '@gogo/providers';

/**
 * NTF-BE-008 (#199) — the identity JWT the mobile client hands to the OneSignal
 * SDK so that a subscription can be bound to `external_id = users.id` with
 * Identity Verification enforced (spec §11–§14).
 *
 * The claim set is the provider's: `iss` = OneSignal app id, `exp`, and
 * `identity.external_id`. ES256, signed with the private key OneSignal issues
 * in *Settings → Keys & IDs → Identity Verification* — a provider-generated
 * key pair, not something GoGo mints. The App API key is a different credential
 * and cannot stand in for it.
 *
 * The user id comes from the authenticated actor and nowhere else. There is no
 * parameter, header or body field that can choose it, which is the whole of
 * the security argument: a token for someone else's id cannot be requested.
 */

/** Spec §14: never longer than an hour; the client refreshes. */
export const IDENTITY_TOKEN_MAX_TTL_SECONDS = 3_600;

/**
 * Normalises the key material an environment can hand us. SSM stores the PEM
 * as one SecureString; `render-env.sh` writes `KEY=value` per line, so the PEM
 * arrives either with its newlines escaped as the two characters `\n` or as
 * base64 of the whole file. Raw PEM (a workstation `.env`) is accepted too.
 *
 * Empty means "not configured" and returns null. Anything else that is not an
 * EC P-256 private key throws — a key of the wrong type would sign tokens the
 * provider refuses, and that should fail at boot, not on a phone.
 */
export function parseIdentitySigningKey(raw: string): KeyObject | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let pem = trimmed.replace(/\\n/g, '\n');
  if (!pem.startsWith('-----BEGIN')) {
    pem = Buffer.from(trimmed, 'base64').toString('utf8').trim();
    if (!pem.startsWith('-----BEGIN')) {
      throw new Error(
        'ONESIGNAL_IDENTITY_VERIFICATION_KEY must be a PEM private key (raw, \\n-escaped, or base64)',
      );
    }
  }

  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (cause) {
    throw new Error('ONESIGNAL_IDENTITY_VERIFICATION_KEY is not a parseable private key', {
      cause,
    });
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('ONESIGNAL_IDENTITY_VERIFICATION_KEY must be an EC P-256 private key (ES256)');
  }
  return key;
}

/** What `POST /v1/notifications/identity/logout` answers. */
export type DeviceUnsubscribeConfirmation = {
  /**
   * True when this device's subscription is no longer able to receive
   * notifications for the caller: absent from their user, or present and
   * disabled. False means the provider still has it enabled.
   */
  confirmed: boolean;
};

/** How long the token minted for a confirmation read is good for. */
const CONFIRM_TOKEN_TTL_SECONDS = 60;

/** One device's push subscription, as the provider reports it. */
export type ProviderSubscription = {
  /** OneSignal's subscription id. Not an APNs or FCM token. */
  id: string;
  /** False for a device that holds the subscription but cannot be delivered to. */
  enabled: boolean;
};

/**
 * NTF-BE-011 (#515) — the provider's own answer to "what does this caller have
 * subscribed", as the two endpoints that need it both see it.
 *
 * A result rather than an exception because the two callers disagree about
 * what each outcome means: to a logout, `no_user` is a confirmation; to a
 * registration it is a refusal. Neither judgement belongs in the read.
 */
export type OwnSubscriptionsRead =
  | { kind: 'ok'; subscriptions: ProviderSubscription[] }
  /** The provider holds no user at this external id — nothing is subscribed. */
  | { kind: 'no_user' }
  /** The provider could not be reached at all. */
  | { kind: 'unreachable' }
  /** Reached, and the answer was not usable: non-2xx, or unparseable. */
  | { kind: 'error' };

export type PushIdentityToken = {
  /** `users.id` — what the SDK logs in with. */
  externalId: string;
  /** The ES256 JWT. Never logged. */
  token: string;
  /** ISO-8601 UTC; the client refreshes before this. */
  expiresAt: string;
};

@Injectable()
export class PushIdentityService {
  private readonly sign: ((payload: Record<string, unknown>) => string) | null;
  /** Signs the short-lived token the confirmation read authenticates with. */
  private readonly signConfirm: ((payload: Record<string, unknown>) => string) | null;
  private readonly appId: string;
  readonly ttlSeconds: number;

  constructor(
    @Inject(APP_CONFIG) config: PushIdentityConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
    /** Injected only by tests; Nest has nothing to provide and must not try. */
    @Optional() private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.appId = config.ONESIGNAL_APP_ID;
    this.ttlSeconds = Math.min(
      Math.max(60, config.ONESIGNAL_IDENTITY_TOKEN_TTL_SECONDS),
      IDENTITY_TOKEN_MAX_TTL_SECONDS,
    );
    const key = parseIdentitySigningKey(config.ONESIGNAL_IDENTITY_VERIFICATION_KEY);
    this.sign =
      key && config.ONESIGNAL_APP_ID
        ? createSigner({
            algorithm: 'ES256',
            key: key.export({ type: 'pkcs8', format: 'pem' }) as string,
            iss: config.ONESIGNAL_APP_ID,
            // fast-jwt takes milliseconds. `iat` is stamped by the signer, so a
            // verifier that allows the usual skew window sees a consistent pair.
            expiresIn: this.ttlSeconds * 1_000,
          })
        : null;
    this.signConfirm =
      key && config.ONESIGNAL_APP_ID
        ? createSigner({
            algorithm: 'ES256',
            key: key.export({ type: 'pkcs8', format: 'pem' }) as string,
            iss: config.ONESIGNAL_APP_ID,
            expiresIn: CONFIRM_TOKEN_TTL_SECONDS * 1_000,
          })
        : null;
  }

  /** False when this environment holds no signing key: the endpoint answers 503. */
  get available(): boolean {
    return this.sign !== null;
  }

  issue(actor: Actor): PushIdentityToken {
    if (actor.type !== 'user') {
      // Guests are room-scoped and receive no push (the dispatcher skips them);
      // an identity for one would bind a device to a session id, not a person.
      throw AppError.forbidden('USER_ONLY', 'Push identity is issued to signed-in users only');
    }
    if (!this.sign) {
      this.metrics.increment('push_identity_tokens_total', { result: 'unavailable' });
      // Not retryable: a missing key does not come back on its own.
      throw AppError.serviceUnavailable(
        'PUSH_IDENTITY_UNAVAILABLE',
        'Push identity signing is not configured in this environment',
        false,
      );
    }
    const token = this.sign({ identity: { external_id: actor.id } });
    // Read `exp` back from the token rather than recomputing it, so the value
    // the client schedules its refresh on is the one the provider will check.
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
      exp: number;
    };
    this.metrics.increment('push_identity_tokens_total', { result: 'issued' });
    return {
      externalId: actor.id,
      token,
      expiresAt: new Date(claims.exp * 1_000).toISOString(),
    };
  }

  /**
   * NTF-APP-004 (#160) — "this device is no longer subscribed for me", asked of
   * the provider rather than of the SDK on the device.
   *
   * The client cannot answer this itself. It holds no REST credential, and
   * `.claude/rules/core.md` rule 12 keeps clients on the BFF, so the read
   * happens here. The SDK's own opt-out state is not the answer either: under
   * Identity Verification logout sets a flag the device-side API does not
   * report, which is exactly how a logout that never reached the provider looks
   * identical to one that did.
   *
   * Scoped to the caller by construction: the only user ever read is the
   * actor's own `external_id`. There is no parameter that can name someone
   * else's, so this cannot report on — or touch — another person's devices. It
   * is a read: nothing is disabled or deleted here, least of all the user.
   */
  async confirmDeviceUnsubscribed(
    actor: Actor,
    subscriptionId: string,
  ): Promise<DeviceUnsubscribeConfirmation> {
    const read = await this.readOwnSubscriptions(actor);

    if (read.kind === 'no_user') {
      // No user at that external id: nothing of theirs can be subscribed.
      this.metrics.increment('push_identity_logout_confirm_total', { result: 'confirmed' });
      return { confirmed: true };
    }
    if (read.kind === 'unreachable') {
      this.metrics.increment('push_identity_logout_confirm_total', { result: 'unreachable' });
      // Retryable: the client is still signed in and will ask again.
      throw AppError.serviceUnavailable(
        'PUSH_UNSUBSCRIBE_UNCONFIRMED',
        'Could not reach the push provider to confirm unsubscription',
        true,
      );
    }
    if (read.kind === 'error') {
      // A non-2xx, or a 200 we cannot parse, is not a confirmation. Same answer
      // as an outage: say so, and let the client keep its session and ask again.
      this.metrics.increment('push_identity_logout_confirm_total', { result: 'error' });
      throw AppError.serviceUnavailable(
        'PUSH_UNSUBSCRIBE_UNCONFIRMED',
        'The push provider did not answer the unsubscription check',
        true,
      );
    }

    const match = read.subscriptions.find((s) => s.id === subscriptionId);
    // Absent means it no longer belongs to this user; present-and-disabled
    // means it does but cannot be delivered to. Either satisfies logout.
    const confirmed = match === undefined || match.enabled !== true;
    this.metrics.increment('push_identity_logout_confirm_total', {
      result: confirmed ? 'confirmed' : 'still_enabled',
    });
    return { confirmed };
  }

  /**
   * NTF-BE-011 (#515) — the caller's own devices, read from the provider.
   *
   * Scoped to the caller by construction: the external id in the URL is the
   * guard-resolved actor's and there is no parameter that can name anyone
   * else's, so nothing here can read — or be made to report on — another
   * person's devices. A read only: it disables and deletes nothing.
   *
   * Counts nothing and throws nothing. Each caller decides what an outcome
   * means for it and records its own metric, because `no_user` is a
   * confirmation to a logout and a refusal to a registration.
   */
  async readOwnSubscriptions(actor: Actor): Promise<OwnSubscriptionsRead> {
    if (actor.type !== 'user') {
      throw AppError.forbidden('USER_ONLY', 'Push identity is issued to signed-in users only');
    }
    if (!this.signConfirm) {
      throw AppError.serviceUnavailable(
        'PUSH_IDENTITY_UNAVAILABLE',
        'Push identity signing is not configured in this environment',
        false,
      );
    }

    const token = this.signConfirm({ identity: { external_id: actor.id } });
    const url = `${ONESIGNAL_API_BASE}/apps/${encodeURIComponent(this.appId)}/users/by/external_id/${encodeURIComponent(actor.id)}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } catch {
      return { kind: 'unreachable' };
    }

    if (response.status === 404) return { kind: 'no_user' };
    if (!response.ok) return { kind: 'error' };

    let body: { subscriptions?: { id?: string; enabled?: boolean }[] };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      return { kind: 'error' };
    }
    return {
      kind: 'ok',
      subscriptions: (body.subscriptions ?? [])
        .filter((s): s is { id: string; enabled?: boolean } => typeof s.id === 'string')
        .map((s) => ({ id: s.id, enabled: s.enabled === true })),
    };
  }
}
