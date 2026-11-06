import { verificationSchema } from '../../shared/venue-verification';
import { describe, expect, it } from 'vitest';
import { searchQuerySchema } from './search.controller';
import { decideAllowance } from '../../assistant/domain/limits';
import { roomListQuery } from '../../rooms/presentation/rooms.controller';

describe('discovery request invariants (#774)', () => {
  it('deduplicates ALL filters and supports multi suitability and cashless expansion', () => {
    const q = searchQuerySchema.parse({
      amenities: 'wifi,wifi,power_outlets,cashless_payment',
      suitedFor: 'couple,work_reading',
      includeTotal: 'true',
    });
    expect(q.amenities).toEqual(['wifi', 'power_outlets', 'cashless_payment']);
    expect(q.suitedFor).toEqual(['couple', 'work_reading']);
    expect(q.includeTotal).toBe(true);
  });
  it('rejects excess values, incomplete positions and inverted prices', () => {
    expect(
      searchQuerySchema.safeParse({
        amenities: Array.from({ length: 11 }, (_, i) => `x${i}`).join(','),
      }).success,
    ).toBe(false);
    expect(searchQuerySchema.safeParse({ lat: '10' }).success).toBe(false);
    expect(
      searchQuerySchema.safeParse({ priceMinPerPerson: '20', priceMaxPerPerson: '10' }).success,
    ).toBe(false);
  });
  it('checks burst even when the daily allowance is exhausted', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    expect(
      decideAllowance(
        { dailyMessageLimit: 1, messagesPerMinuteLimit: 1 },
        { acceptedToday: 1, burstAcceptedAt: [now] },
        now,
      ),
    ).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  });
  it('Home rejects pagination and status overrides', () => {
    expect(roomListQuery.safeParse({ view: 'home', cursor: 'abc' }).success).toBe(false);
    expect(roomListQuery.safeParse({ view: 'home', status: 'active' }).success).toBe(false);
  });
  it('requires approved independent evidence for a badge and permits revocation', () => {
    expect(verificationSchema.safeParse({ status: 'verified', reason: 'Checked' }).success).toBe(
      false,
    );
    expect(
      verificationSchema.safeParse({
        status: 'verified',
        evidenceType: 'provider_confidence',
        evidenceReference: '0.99',
        reason: 'Checked',
      }).success,
    ).toBe(false);
    expect(
      verificationSchema.safeParse({
        status: 'verified',
        evidenceType: 'site_visit',
        evidenceReference: 'evidence/774',
        reason: 'Identity and location checked',
      }).success,
    ).toBe(true);
    expect(
      verificationSchema.safeParse({ status: 'unverified', reason: 'Location changed' }).success,
    ).toBe(true);
  });
});
