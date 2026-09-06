import { Inject, Injectable, Optional } from '@nestjs/common';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { createSigner } from 'fast-jwt';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import type { Actor } from '../../identity/domain/actor';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type PushIdentityConfig } from '../../shared/config';

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
  readonly ttlSeconds: number;

  constructor(
    @Inject(APP_CONFIG) config: PushIdentityConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {
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
}
