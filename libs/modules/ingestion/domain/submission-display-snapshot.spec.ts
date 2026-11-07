import { afterEach, expect, it, vi } from 'vitest';
import { freshSnapshot, SUBMISSION_DISPLAY_MAX_AGE_MS } from './submission-display-snapshot';

const now = new Date('2026-11-07T00:00:00.000Z');
const snapshot = {
  source: 'google_places',
  fetchedAt: now.toISOString(),
  name: 'Café',
  addressShort: 'Hà Nội',
  attributions: ['Google Maps'],
  googleMapsUri: null,
  googleRating: null,
  googleRatingCount: 0,
  openingHours: [],
};
afterEach(() => vi.useRealTimers());

it.each([
  [SUBMISSION_DISPLAY_MAX_AGE_MS - 1, true],
  [SUBMISSION_DISPLAY_MAX_AGE_MS, true],
  [SUBMISSION_DISPLAY_MAX_AGE_MS + 1, false],
  [-1, false],
])('#801 snapshot age %s is fresh=%s without rewriting fetchedAt', (age, fresh) => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const value = { ...snapshot, fetchedAt: new Date(now.getTime() - age).toISOString() };
  expect(freshSnapshot(value)).toEqual(fresh ? value : undefined);
});

it('#801 hides malformed historical snapshots and strips photo/raw fields before reuse', () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  expect(freshSnapshot({ ...snapshot, fetchedAt: 'invalid' })).toBeUndefined();
  expect(freshSnapshot({ ...snapshot, photo: 'private', raw: 'private' })).toEqual(snapshot);
});
