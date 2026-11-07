import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RESOLUTION_ATTESTATION_VERSION,
  MAX_RESOLUTION_TOKEN_LENGTH,
  signResolutionAttestation,
  verifyResolutionAttestation,
} from './resolution-attestation';

const SECRET = 'resolution-attestation-test-secret-0123456789';
const PLACE = 'GOGOTEST_PLACE_01';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-09-02T10:00:00.000Z');

function mint(overrides: Partial<Record<string, unknown>> = {}, secret = SECRET): string {
  const payload = {
    version: RESOLUTION_ATTESTATION_VERSION,
    purpose: 'place_submission',
    googlePlaceId: PLACE,
    verifiedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    ...overrides,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest();
  return `${body}.${sig.toString('base64url')}`;
}

describe('#337 — resolution attestation', () => {
  it('round-trips the Place ID and the window it is good for', () => {
    const token = signResolutionAttestation({
      googlePlaceId: PLACE,
      secret: SECRET,
      ttlSeconds: 600,
      now: NOW,
    });
    const verdict = verifyResolutionAttestation(token, { secret: SECRET, now: NOW });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.attestation.googlePlaceId).toBe(PLACE);
    expect(verdict.attestation.verifiedAt).toBe('2026-09-02T10:00:00.000Z');
    expect(verdict.attestation.expiresAt).toBe('2026-09-02T10:10:00.000Z');
  });

  // #801 keeps legacy identity-only tokens valid during rollout.
  it('carries no Google content — only the id, and the window', () => {
    const token = signResolutionAttestation({
      googlePlaceId: PLACE,
      secret: SECRET,
      ttlSeconds: 600,
      now: NOW,
    });
    const body = JSON.parse(
      Buffer.from(token.slice(0, token.indexOf('.')), 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      'expiresAt',
      'googlePlaceId',
      'purpose',
      'verifiedAt',
      'version',
    ]);
  });

  it('refuses a token signed with another secret', () => {
    const token = signResolutionAttestation({
      googlePlaceId: PLACE,
      secret: 'a-different-secret-entirely-0123456789',
      ttlSeconds: 600,
      now: NOW,
    });

    expect(verifyResolutionAttestation(token, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it('refuses a token whose Place ID was edited', () => {
    const token = signResolutionAttestation({
      googlePlaceId: PLACE,
      secret: SECRET,
      ttlSeconds: 600,
      now: NOW,
    });
    const [, signature] = token.split('.');
    const swapped = Buffer.from(
      JSON.stringify({
        version: RESOLUTION_ATTESTATION_VERSION,
        purpose: 'place_submission',
        googlePlaceId: 'GOGOTEST_SOMEWHERE_ELSE',
        verifiedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      }),
    ).toString('base64url');

    expect(
      verifyResolutionAttestation(`${swapped}.${signature}`, { secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('expires exactly at expiresAt, not a second later', () => {
    const token = signResolutionAttestation({
      googlePlaceId: PLACE,
      secret: SECRET,
      ttlSeconds: 600,
      now: NOW,
    });

    expect(
      verifyResolutionAttestation(token, { secret: SECRET, now: at('2026-09-02T10:09:59.999Z') })
        .ok,
    ).toBe(true);
    expect(
      verifyResolutionAttestation(token, { secret: SECRET, now: at('2026-09-02T10:10:00.000Z') }),
    ).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('refuses a correctly signed token minted for another purpose', () => {
    expect(
      verifyResolutionAttestation(mint({ purpose: 'place_publish' }), {
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'WRONG_PURPOSE' });
  });

  it('names an unknown version rather than calling it malformed', () => {
    expect(verifyResolutionAttestation(mint({ version: 2 }), { secret: SECRET, now: NOW })).toEqual(
      {
        ok: false,
        reason: 'UNSUPPORTED_VERSION',
      },
    );
  });

  /**
   * Signature before contents: answering "expired" for a forgery would confirm
   * to whoever wrote it that the payload parsed.
   */
  it('reports a bad signature for a forged token that is also expired', () => {
    const forged = mint({ expiresAt: '2020-01-01T00:00:00.000Z' }, 'not-the-real-secret');

    expect(verifyResolutionAttestation(forged, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
  });

  it.each([
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['empty body', '.c2ln'],
    ['empty signature', 'YWJj.'],
    ['three parts', 'YWJj.c2ln.ZXh0cmE'],
    ['oversized', `${'a'.repeat(MAX_RESOLUTION_TOKEN_LENGTH)}.c2ln`],
  ])('refuses a %s token as malformed', (_label, token) => {
    expect(verifyResolutionAttestation(token, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
  });

  /**
   * An unconfigured secret must never verify. `''` as an HMAC key is legal in
   * Node, so without this guard a deployment that lost its secret would happily
   * accept tokens anybody could mint.
   */
  it('verifies nothing when no secret is configured', () => {
    const token = signResolutionAttestation({
      googlePlaceId: PLACE,
      secret: '',
      ttlSeconds: 600,
      now: NOW,
    });

    expect(verifyResolutionAttestation(token, { secret: '', now: NOW })).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
  });
});

const displaySnapshot = {
  source: 'google_places' as const,
  fetchedAt: NOW.toISOString(),
  name: 'Snapshot café',
  addressShort: 'Hà Nội',
  attributions: ['Google Maps'],
  googleMapsUri: null,
  googleRating: 4.6,
  googleRatingCount: 980,
  openingHours: [],
};
it('#801 signs only allowed display facts, preserving fetchedAt and no photo/raw fields', () => {
  const token = signResolutionAttestation({
    googlePlaceId: PLACE,
    secret: SECRET,
    ttlSeconds: 600,
    now: NOW,
    displaySnapshot: {
      ...displaySnapshot,
      photo: 'private',
      raw: 'private',
    } as typeof displaySnapshot,
  });
  const answer = verifyResolutionAttestation(token, { secret: SECRET, now: NOW });
  expect(answer.ok && answer.attestation.displaySnapshot).toEqual(displaySnapshot);
  expect(Buffer.from(token.split('.')[0]!, 'base64url').toString()).not.toContain('private');
  const [body, signature] = token.split('.');
  const forged = Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(body!, 'base64url').toString()),
      displaySnapshot: { ...displaySnapshot, name: 'Forged' },
    }),
  ).toString('base64url');
  expect(
    verifyResolutionAttestation(`${forged}.${signature}`, { secret: SECRET, now: NOW }),
  ).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
});
it('#801 rejects a signed snapshot with a fake fetch time or invalid rating', () => {
  for (const snapshot of [
    { ...displaySnapshot, fetchedAt: '2020-01-01T00:00:00.000Z' },
    { ...displaySnapshot, googleRating: 99 },
  ]) {
    expect(
      verifyResolutionAttestation(mint({ displaySnapshot: snapshot }), {
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'MALFORMED' });
  }
});
