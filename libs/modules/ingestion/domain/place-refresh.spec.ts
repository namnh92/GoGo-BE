import { describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_DAYS,
  MAX_REFRESH_ATTEMPTS,
  REFRESH_INTERVAL_DAYS,
  TRANSIENT_BASE_MINUTES,
  TRANSIENT_MAX_MINUTES,
  classifyLiveness,
  scheduleFor,
} from './place-refresh';

/**
 * PR7 (#340) — the transition table, pinned before the job that walks it.
 *
 * Every row of plan §2.5 appears here once. A change to the prose that does
 * not change one of these is not a change to the behaviour.
 */

const NOW = new Date('2026-09-02T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const days = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);
const minutes = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);

describe('classifyLiveness', () => {
  it('same id back is alive', () => {
    expect(
      classifyLiveness({
        requestedExternalId: 'ChIJ_a',
        identity: { providerPlaceId: 'ChIJ_a', fetchTier: 'liveness' } as never,
      }),
    ).toEqual({ kind: 'alive' });
  });

  it('reads movedPlaceId as a move, naming the successor', () => {
    expect(
      classifyLiveness({
        requestedExternalId: 'ChIJ_a',
        identity: { providerPlaceId: 'ChIJ_a', movedPlaceId: 'ChIJ_b' } as never,
      }),
    ).toEqual({ kind: 'moved', movedToExternalId: 'ChIJ_b', signal: 'moved_place_id' });
  });

  it('reads an answer about a different id as a move too — the signal Google does not announce', () => {
    expect(
      classifyLiveness({
        requestedExternalId: 'ChIJ_a',
        identity: { providerPlaceId: 'ChIJ_b', requestedProviderPlaceId: 'ChIJ_a' } as never,
      }),
    ).toEqual({ kind: 'moved', movedToExternalId: 'ChIJ_b', signal: 'answered_as' });
  });

  it('prefers movedPlaceId when both signals are present', () => {
    expect(
      classifyLiveness({
        requestedExternalId: 'ChIJ_a',
        identity: { providerPlaceId: 'ChIJ_b', movedPlaceId: 'ChIJ_c' } as never,
      }),
    ).toMatchObject({ movedToExternalId: 'ChIJ_c', signal: 'moved_place_id' });
  });

  it('a rejected id is an identity problem, carrying Google canonical status', () => {
    expect(
      classifyLiveness({
        requestedExternalId: 'ChIJ_a',
        identity: null,
        rejectedWith: 'NOT_FOUND',
      }),
    ).toEqual({ kind: 'invalid_identity', errorCode: 'NOT_FOUND' });
  });

  it('an empty answer is an identity problem with its own code, never a silent success', () => {
    expect(classifyLiveness({ requestedExternalId: 'ChIJ_a', identity: null })).toEqual({
      kind: 'invalid_identity',
      errorCode: 'EMPTY_ANSWER',
    });
  });

  it('an unavailable provider outranks everything else — it is not the row failing', () => {
    expect(
      classifyLiveness({
        requestedExternalId: 'ChIJ_a',
        identity: null,
        rejectedWith: 'NOT_FOUND',
        unavailableWith: 'PROVIDER_QUOTA_EXCEEDED',
      }),
    ).toEqual({ kind: 'provider_error', errorCode: 'PROVIDER_QUOTA_EXCEEDED' });
  });
});

describe('scheduleFor', () => {
  it('alive schedules the flat cadence and clears the failure count', () => {
    const next = scheduleFor({ kind: 'alive' }, { attempts: 2, transientFailures: 1 }, NOW);
    expect(next).toMatchObject({ state: 'alive', attempts: 0, errorCode: null });
    expect(days(NOW, (next as { refreshAfter: Date }).refreshAfter)).toBe(REFRESH_INTERVAL_DAYS);
  });

  it('moved goes dormant: a person decides, and the ceiling is not spent re-asking', () => {
    const next = scheduleFor(
      { kind: 'moved', movedToExternalId: 'ChIJ_b', signal: 'moved_place_id' },
      { attempts: 0, transientFailures: 0 },
      NOW,
    );
    expect(next).toMatchObject({ state: 'moved', refreshAfter: null, attempts: 0 });
  });

  it('first rejection waits one base interval', () => {
    const next = scheduleFor(
      { kind: 'invalid_identity', errorCode: 'NOT_FOUND' },
      { attempts: 0, transientFailures: 0 },
      NOW,
    );
    expect(next).toMatchObject({ state: 'retry', attempts: 1 });
    expect(days(NOW, (next as { refreshAfter: Date }).refreshAfter)).toBe(BACKOFF_BASE_DAYS);
  });

  it('second rejection doubles it', () => {
    const next = scheduleFor(
      { kind: 'invalid_identity', errorCode: 'NOT_FOUND' },
      { attempts: 1, transientFailures: 0 },
      NOW,
    );
    expect(next).toMatchObject({ state: 'retry', attempts: 2 });
    expect(days(NOW, (next as { refreshAfter: Date }).refreshAfter)).toBe(BACKOFF_BASE_DAYS * 2);
  });

  it('the third stops the asking without asserting the place is closed', () => {
    const next = scheduleFor(
      { kind: 'invalid_identity', errorCode: 'INVALID_ARGUMENT' },
      { attempts: 2, transientFailures: 0 },
      NOW,
    );
    expect(next).toMatchObject({
      state: 'dormant',
      refreshAfter: null,
      attempts: MAX_REFRESH_ATTEMPTS,
      errorCode: 'INVALID_ARGUMENT',
    });
  });

  it('defers a provider error instead of leaving the row hot, and counts it apart', () => {
    const next = scheduleFor(
      { kind: 'provider_error', errorCode: 'QUOTA_EXCEEDED' },
      { attempts: 2, transientFailures: 0 },
      NOW,
    );
    expect(next).toMatchObject({
      state: 'deferred',
      transientFailures: 1,
      errorCode: 'QUOTA_EXCEEDED',
    });
    expect(minutes(NOW, (next as { refreshAfter: Date }).refreshAfter)).toBe(
      TRANSIENT_BASE_MINUTES,
    );
    // The invalid-identity counter is untouched: an outage is not evidence
    // about a Place ID, and three outages must never look like a dead id.
    expect(next).not.toHaveProperty('attempts');
  });

  it('doubles the transient wait and caps it', () => {
    const steps = [0, 1, 2, 3, 4, 5, 9].map((transientFailures) => {
      const next = scheduleFor(
        { kind: 'provider_error', errorCode: 'PROVIDER_UNAVAILABLE' },
        { attempts: 0, transientFailures },
        NOW,
      );
      return minutes(NOW, (next as { refreshAfter: Date }).refreshAfter);
    });
    expect(steps).toEqual([30, 60, 120, 240, 360, 360, 360]);
    expect(Math.max(...steps)).toBe(TRANSIENT_MAX_MINUTES);
  });

  it('a definitive answer clears the transient count', () => {
    // The reset lives in the writer, but the contract is stated here: an
    // `alive` schedule carries attempts 0 and no transient state to carry over.
    expect(
      scheduleFor({ kind: 'alive' }, { attempts: 0, transientFailures: 4 }, NOW),
    ).toMatchObject({
      state: 'alive',
      attempts: 0,
    });
  });
});
