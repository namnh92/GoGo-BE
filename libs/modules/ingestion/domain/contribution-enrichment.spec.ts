import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { enrichmentDraftSchema, enrichmentSchema } from './contribution-enrichment';
import { assertContributor, validateEnrichment } from '../application/contribution-enrichment';
import type { Actor } from '../../identity/domain/actor';

export const completeEnrichment = {
  price: { min: 20000, max: 50000, currency: 'VND' as const, unit: 'per_item' as const },
  purposeKeys: ['work_reading'],
  vibeKeys: ['chill'],
  amenities: { car_parking: false, power_at_each_table: true },
  service: { rating: 5, chipKeys: ['service_friendly'] },
  space: { rating: 4, chipKeys: ['space_quiet'] },
};
describe('contribution wizard validation (#796)', () => {
  it('allows partial drafts but requires completed steps on submit', () => {
    expect(enrichmentDraftSchema.parse({})).toEqual({});
    expect(enrichmentSchema.safeParse({}).success).toBe(false);
    expect(enrichmentSchema.parse(completeEnrichment)).toEqual(completeEnrichment);
    expect(enrichmentSchema.safeParse({ ...completeEnrichment, price: undefined }).success).toBe(
      true,
    );
  });
  it.each([
    { price: { min: 1, max: 2, currency: 'VND' } },
    { price: { min: 2, max: 1, currency: 'VND', unit: 'per_person' } },
    { price: { min: 1.2, max: 2, currency: 'VND', unit: 'per_person' } },
    { price: { min: 1, max: 2, currency: 'VND', unit: 'free' } },
    { vibeKeys: [] },
    { vibeKeys: ['a', 'b', 'c', 'd'] },
    { vibeKeys: ['chill', 'chill'] },
    { purposeKeys: [''] },
    { service: { rating: 6, chipKeys: [] } },
    { space: { rating: 0, chipKeys: [] } },
    { space: { rating: 2.5, chipKeys: [] } },
    { photos: Array.from({ length: 6 }, () => ({ mediaId: randomUUID(), kind: 'bill' })) },
    { photos: [{ mediaId: randomUUID(), kind: 'bill', masked: true }] },
    { photos: [{ url: 'https://raw-receipt.test/receipt.jpg', kind: 'bill' }] },
    { visitTips: 'x'.repeat(2001) },
    { credit: 70 },
  ])('rejects invalid claims %j', (patch) => {
    expect(enrichmentSchema.safeParse({ ...completeEnrichment, ...patch }).success).toBe(false);
  });
  it.each(['guest', 'admin'])('refuses %s contributor', (type) => {
    expect(() => assertContributor({ type } as Actor)).toThrow('Registered user required');
  });
  it('blocks unmasked evidence before DB access', async () => {
    const db = { select: vi.fn() };
    await expect(
      validateEnrichment(db as never, { photos: [{ mediaId: randomUUID(), kind: 'bill' }] }),
    ).rejects.toMatchObject({
      code: 'SUBMISSION_EVIDENCE_BLOCKED',
      httpStatus: 503,
      options: { retryable: false },
    });
    expect(db.select).not.toHaveBeenCalled();
  });
  it('checks taxonomy kind without imposing a service/space prefix', async () => {
    const rows = [
      ['suitability', 'work_reading'],
      ['mood', 'chill'],
      ['amenity', 'car_parking'],
      ['amenity', 'power_at_each_table'],
      ['checkin_tag', 'service_friendly'],
      ['checkin_tag', 'space_quiet'],
      ['amenity', 'cms_new_amenity'],
      ['amenity', '24_hour'],
      ...[
        'friendly_staff',
        'fast_service',
        'pleasant_music',
        'quiet_private',
        'acoustic_music',
        'airy_garden',
        'cool_indoor',
        'rooftop_view',
        'photo_spot',
      ].map((key) => ['checkin_tag', key]),
    ].map(([kind, key]) => ({ kind, key }));
    const db = { select: () => ({ from: () => ({ where: async () => rows }) }) };
    await expect(validateEnrichment(db as never, completeEnrichment)).resolves.toBeUndefined();
    for (const key of [
      'friendly_staff',
      'fast_service',
      'pleasant_music',
      'quiet_private',
      'acoustic_music',
      'airy_garden',
      'cool_indoor',
      'rooftop_view',
      'photo_spot',
    ]) {
      await expect(
        validateEnrichment(db as never, {
          ...completeEnrichment,
          amenities: { cms_new_amenity: false, '24_hour': true },
          service: { rating: 5, chipKeys: [key] },
          space: { rating: 3, chipKeys: [key] },
          photos: [{ kind: 'menu', mediaId: randomUUID() }],
        }),
      ).resolves.toBeUndefined();
    }
    await expect(
      validateEnrichment(db as never, { ...completeEnrichment, vibeKeys: ['not_active'] }),
    ).rejects.toMatchObject({ code: 'INVALID_TAXONOMY_KEYS' });
    await expect(
      validateEnrichment(db as never, {
        ...completeEnrichment,
        service: { rating: 5, chipKeys: ['space_quiet'] },
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateEnrichment(db as never, {
        ...completeEnrichment,
        amenities: { power_outlets: true },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TAXONOMY_KEYS' });
  });
});

describe('contribution free text log boundary', () => {
  it('drops storage parameters, causes and raw receipt text from error paths', async () => {
    const { contributionStorageFailure } =
      await import('../application/contribution-enrichment.js');
    const raw = new Error('Failed query params: PRIVATE-TIP private-receipt-name');
    let sanitised: unknown;
    try {
      contributionStorageFailure(raw);
    } catch (error) {
      sanitised = error;
    }
    expect(sanitised).toMatchObject({ code: 'CONTRIBUTION_STORAGE_UNAVAILABLE' });
    expect(String(sanitised)).not.toContain('PRIVATE');
    expect((sanitised as Error).cause).toBeUndefined();
    const { requestSerializer, errorSerializer } = await import('@gogo/observability');
    expect(
      JSON.stringify(
        requestSerializer({
          method: 'PUT',
          url: '/v1/place-contribution-drafts/id',
          body: { visitTips: 'PRIVATE-TIP' },
        } as never),
      ),
    ).not.toContain('PRIVATE');
    expect(JSON.stringify(errorSerializer(sanitised))).not.toContain('PRIVATE');
  });
});
