/** Fictional server-authored fixtures, for S1 tests only; no provider snapshot. */
import { answerToken } from './tokens';
import type { PlaceFacts, VerifiedFact } from './place-facts';
import type { PlaceAnswerGroup } from './reference-group';
export const FIXTURE_A = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_B = '22222222-2222-4222-8222-222222222222';
export const FIXTURE_C = '33333333-3333-4333-8333-333333333333';
export function verified<T>(
  value: T,
  tier: 'verified_current' | 'verified_reference' = 'verified_current',
): VerifiedFact<T> {
  return {
    tier,
    value,
    verifiedAt: '2026-11-10T00:00:00Z',
    source: { kind: 'gogo', collectedAt: '2026-11-09T00:00:00Z' },
  };
}
export function fictionalPlace(id = FIXTURE_A, name = 'Fictional Lantern'): PlaceFacts {
  return {
    id,
    name,
    available: true,
    facts: {
      price: [verified([{ min: 12000, max: 24000, currency: 'VND', unit: 'per_person' }])],
      hours: [
        {
          day: 3,
          intervals: [
            verified({ kind: 'interval', openMinute: 540, closeMinute: 720 }),
            verified({ kind: 'interval', openMinute: 1080, closeMinute: 120, overnight: true }),
          ],
        },
      ],
      address: verified('12 Fictional Street'),
      contact: verified('+84912345678'),
      amenity: [
        verified([
          { key: 'parking', labels: { vi: 'bãi đỗ xe', en: 'parking' } },
          { key: 'wifi', labels: { vi: 'wifi', en: 'wifi' } },
        ]),
      ],
      suitability: [verified([{ key: 'group', labels: { vi: 'nhóm bạn', en: 'groups' } }])],
      overview: [verified([{ key: 'cafe', labels: { vi: 'cà phê', en: 'café' } }])],
    },
  };
}
export function fixtureRow(id = 'message-a', ids: readonly string[] = [FIXTURE_A]) {
  const queries = ids.map((placeId) => answerToken({ placeId, locale: 'en', topic: 'price' }));
  const group: PlaceAnswerGroup = {
    v: 1,
    kind: ids.length === 2 ? 'compare' : 'answer',
    cards: ids,
    sources: queries,
    options: [
      {
        id: 'hours',
        query: answerToken({
          placeId: ids[0]!,
          locale: 'en',
          topic: 'hours',
          day: 'weekday',
          d: 3,
        }),
      },
    ],
  };
  return {
    id,
    text: queries.join('\n'),
    locale: 'en' as const,
    trace: { route: 'place_qa', placeAnswerGroup: group },
  };
}
