import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * #337 identity attestation, extended by #801 owner decision (ADR-0048).
 * A signed resolution ID references a short-lived server-side display snapshot;
 * only submit persists it on the submission. No display facts travel in the token.
 * Legacy identity-only tokens remain valid. Signature, expiry and Place ID checks
 * still gate submission; the snapshot never bypasses authorization or moderation.
 */

export const RESOLUTION_ATTESTATION_VERSION = 1;
export const RESOLUTION_PURPOSE = 'place_submission';

/** Long enough for any Place ID, short enough that no parser is a DoS target. */
export const MAX_RESOLUTION_TOKEN_LENGTH = 1024;

export type ResolutionAttestation = {
  version: typeof RESOLUTION_ATTESTATION_VERSION;
  purpose: typeof RESOLUTION_PURPOSE;
  googlePlaceId: string;
  /** ISO-8601 UTC. */
  verifiedAt: string;
  /** ISO-8601 UTC — `verifiedAt` + PLACE_RESOLUTION_TTL_S. */
  expiresAt: string;
  resolutionId?: string;
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
  resolutionId?: string;
}): string {
  const now = input.now ?? new Date();
  const attestation: ResolutionAttestation = {
    ...(input.resolutionId ? { resolutionId: input.resolutionId } : {}),
    version: RESOLUTION_ATTESTATION_VERSION,
    purpose: RESOLUTION_PURPOSE,
    googlePlaceId: input.googlePlaceId,
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
  };
  const body = b64url(Buffer.from(JSON.stringify(attestation)));
  const token = `${body}.${b64url(sign(body, input.secret))}`;
  if (token.length > MAX_RESOLUTION_TOKEN_LENGTH) throw new Error('Resolution token too long');
  return token;
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
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > MAX_RESOLUTION_TOKEN_LENGTH
  ) {
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

  if (claim.resolutionId !== undefined) {
    if (
      typeof claim.resolutionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        claim.resolutionId,
      )
    )
      return { ok: false, reason: 'MALFORMED' };
  }
  return { ok: true, attestation: claim as ResolutionAttestation };
}
