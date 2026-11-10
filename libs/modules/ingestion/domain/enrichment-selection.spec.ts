import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SubmissionEnrichment } from '@gogo/database';
import {
  enrichmentFacts,
  enrichmentSelectionSchema,
  selectEnrichment,
} from './enrichment-selection';
import { submissionCreditFacts } from '../../shared/assistant-credits';

const menu = randomUUID(),
  bill = randomUUID();
const value: SubmissionEnrichment = {
  price: { min: 0, max: 0, currency: 'VND', unit: 'free' },
  purposeKeys: ['work_reading', 'family'],
  vibeKeys: ['chill'],
  amenities: { car_parking: false, open_after_23: true },
  recommendedDishes: 'Soup',
  visitTips: 'Book ahead',
  service: { rating: 5, chipKeys: ['service_friendly', 'service_attentive'] },
  space: { rating: 4, chipKeys: [] },
  billPhotoPublicConsent: true,
  photos: [
    { mediaId: menu, kind: 'menu' },
    { mediaId: bill, kind: 'bill' },
  ],
};
describe('wizard keep/drop selection (#806)', () => {
  it('keeps individual facts including false/zero and identifies every dropped item', () => {
    const result = selectEnrichment(value, {
      keptFactKeys: ['price', 'amenities:car_parking', 'service.rating'],
      keptPhotoMediaIds: [bill],
    });
    expect(result.facts).toEqual({
      price: value.price,
      'amenities:car_parking': false,
      'service.rating': 5,
    });
    expect(result.keptPhotoMediaIds).toEqual([bill]);
    expect(result.droppedPhotoMediaIds).toEqual([menu]);
    expect(result.droppedFactKeys).toContain('service.chipKeys:service_friendly');
    expect(result.droppedFactKeys).toContain('purposeKeys:family');
    expect(Object.keys(enrichmentFacts(value))).not.toContain('billPhotoPublicConsent');
  });
  it('all-drop applies nothing and still earns only base', () => {
    const selected = selectEnrichment(value, { keptFactKeys: [], keptPhotoMediaIds: [] });
    expect(selected.facts).toEqual({});
    expect(selected.droppedPhotoMediaIds).toHaveLength(2);
    expect(submissionCreditFacts(selected.keptPhotoMediaIds.length)).toEqual({
      base: 50,
      photoBonus: 0,
      total: 50,
    });
  });
  it('stable keys survive array reorder; all-keep grants one bounded bonus', () => {
    const input = {
      keptFactKeys: Object.keys(enrichmentFacts(value)),
      keptPhotoMediaIds: [menu, bill],
    };
    const selected = selectEnrichment(value, input);
    expect(
      selectEnrichment(
        {
          ...value,
          purposeKeys: [...value.purposeKeys!].reverse(),
          photos: [...value.photos!].reverse(),
        },
        input,
      ),
    ).toEqual(selected);
    expect(submissionCreditFacts(selected.keptPhotoMediaIds.length)).toEqual({
      base: 50,
      photoBonus: 10,
      total: 60,
    });
  });
  it.each(['unknown', 'billPhotoPublicConsent', 'photos', 'purposeKeys', 'amenities:missing'])(
    'rejects unavailable/non-fact key %s',
    (key) => {
      expect(() =>
        selectEnrichment(value, { keptFactKeys: [key], keptPhotoMediaIds: [] }),
      ).toThrow();
    },
  );
  it('rejects foreign photos, duplicates and malformed selection; normalizes UUIDs', () => {
    expect(() =>
      selectEnrichment(value, { keptFactKeys: [], keptPhotoMediaIds: [randomUUID()] }),
    ).toThrow();
    expect(
      enrichmentSelectionSchema.safeParse({
        keptFactKeys: ['price', 'price'],
        keptPhotoMediaIds: [],
      }).success,
    ).toBe(false);
    expect(
      enrichmentSelectionSchema.safeParse({
        keptFactKeys: [],
        keptPhotoMediaIds: [menu, menu.toUpperCase()],
      }).success,
    ).toBe(false);
    expect(enrichmentSelectionSchema.safeParse({ keptFactKeys: [] }).success).toBe(false);
    expect(
      selectEnrichment(value, { keptFactKeys: [], keptPhotoMediaIds: [menu.toUpperCase()] })
        .keptPhotoMediaIds,
    ).toEqual([menu]);
  });
  it('handles old submissions with no proposal', () => {
    expect(selectEnrichment(null, { keptFactKeys: [], keptPhotoMediaIds: [] }).facts).toEqual({});
    expect(submissionCreditFacts(0, false)).toEqual({ base: 0, photoBonus: 0, total: 0 });
  });
});
