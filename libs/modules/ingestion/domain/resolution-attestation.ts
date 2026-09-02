import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * COST-BE-004 (#337) / plan §2.8 — proof that GoGo recently verified a Google
 * Place ID, and nothing else.
 *
 * The mobile flow used to pay for the same Enterprise `details` twice: once so
 * the user could see what they were about to add, once so the server could
 * believe them. The obvious fix — keep the resolve result and read it back on
 * submit — is the one ADR-0006 §9.5 forbids, because a provider response held
 * across requests is a cached Google snapshot however short-lived it is.
 *
 * So nothing is kept. The server signs a statement about its own past action
 * and hands it to the client, which hands it back. The statement carries the
 * Place ID (SST §3 permits storing that indefinitely), when the check happened
 * and when the proof stops counting — no name, address, coordinates, rating,
 * hours, business status, photos or raw payload. There is no server-side store
 * to purge, because there is no server-side store.
 *
 * **Closure rides in the issuing decision, not in the payload.** `businessStatus`
 * is Google content, so it cannot travel here; instead a token is only ever
 * minted for a place Google called `OPERATIONAL` at resolve time. Holding one
 * therefore *is* the closure check the submit path used to re-fetch for, and a
 * closed place simply gets no token and takes the old route.
 *
 * What it deliberately does not do:
 *
 * - **It does not authorise anybody.** No actor binding in v1 (plan §2.8): the
 *   submit endpoint still authenticates, still scopes guests to their room and
 *   still dedups. Replaying someone else's token buys the replayer one skipped
 *   Google call on a place they could have resolved themselves for free.
 * - **It is not a session.** Past `expiresAt` it is refused and the client is
 *   told to resolve again, which costs one `details` — the thing this exists to
 *   avoid, so the TTL is a cost/replay trade, not a UX one.
 */

export const RESOLUTION_ATTESTATION_VERSION = 1;
export const RESOLUTION_PURPOSE = 'place_submission';

/** Long enough for any Place ID, short enough that no parser is a DoS target. */
const MAX_TOKEN_LENGTH = 1024;

export type ResolutionAttestation = {
  version: typeof RESOLUTION_ATTESTATION_VERSION;
  purpose: typeof RESOLUTION_PURPOSE;
  googlePlaceId: string;
  /** ISO-8601 UTC. */
  verifiedAt: string;
  /** ISO-8601 UTC — `verifiedAt` + PLACE_RESOLUTION_TTL_S. */
  expiresAt: string;
};

/**
 * Why a token was not accepted.
 *
 * `EXPIRED` is kept apart from the rest on purpose: it is the only one a
 * well-behaved client produces on its own, by taking longer than the TTL to
 * press submit. The others mean the token was never ours, or was edited. The
 * client's next move is the same in every case — resolve again — but ours is
 * not: expiry is a TTL question, a bad signature is a security event.
 */
export type AttestationRejection =
  'MALFORMED' | 'BAD_SIGNATURE' | 'UNSUPPORTED_VERSION' | 'WRONG_PURPOSE' | 'EXPIRED';

export type AttestationVerdict =
  { ok: true; attestation: ResolutionAttestation } | { ok: false; reason: AttestationRejection };

function b64url(value: Buffer): string {
  return value.toString('base64url');
}

function sign(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

/**
 * Signs a fresh attestation.
 *
 * The HMAC covers the encoded body byte for byte rather than a re-serialised
 * object, so a verifier never has to reproduce this function's JSON key order
 * to get the same signature.
 */
export function signResolutionAttestation(input: {
  googlePlaceId: string;
  secret: string;
  ttlSeconds: number;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const attestation: ResolutionAttestation = {
    version: RESOLUTION_ATTESTATION_VERSION,
    purpose: RESOLUTION_PURPOSE,
    googlePlaceId: input.googlePlaceId,
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
  };
  const body = b64url(Buffer.from(JSON.stringify(attestation)));
  return `${body}.${b64url(sign(body, input.secret))}`;
}

/**
 * Checks signature first, contents second.
 *
 * Order matters: reporting "expired" for a token we never issued would tell an
 * attacker their forgery parsed. Nothing about the payload is believed until
 * the MAC says it is ours, and the comparison is constant-time so a wrong
 * signature leaks no timing.
 */
export function verifyResolutionAttestation(
  token: string,
  input: { secret: string; expectedPurpose?: string; now?: Date },
): AttestationVerdict {
  if (!input.secret) return { ok: false, reason: 'MALFORMED' };
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'MALFORMED' };
  }

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const body = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = sign(body, input.secret);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'MALFORMED' };
  const claim = parsed as Partial<ResolutionAttestation>;

  // A version we do not know is not a malformed token — it is a token from a
  // deployment that rotated ahead of this one, and saying so is what makes a
  // rotation debuggable.
  if (claim.version !== RESOLUTION_ATTESTATION_VERSION) {
    return { ok: false, reason: 'UNSUPPORTED_VERSION' };
  }
  if (claim.purpose !== (input.expectedPurpose ?? RESOLUTION_PURPOSE)) {
    return { ok: false, reason: 'WRONG_PURPOSE' };
  }
  if (typeof claim.googlePlaceId !== 'string' || claim.googlePlaceId.length === 0) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (typeof claim.verifiedAt !== 'string' || typeof claim.expiresAt !== 'string') {
    return { ok: false, reason: 'MALFORMED' };
  }
  const expiresAt = Date.parse(claim.expiresAt);
  if (Number.isNaN(expiresAt)) return { ok: false, reason: 'MALFORMED' };
  if ((input.now ?? new Date()).getTime() >= expiresAt) return { ok: false, reason: 'EXPIRED' };

  return { ok: true, attestation: claim as ResolutionAttestation };
}
