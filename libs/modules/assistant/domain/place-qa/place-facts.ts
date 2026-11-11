import type { AnswerTopic } from './tokens';

export type VerifiedFact<T> = Readonly<{
  tier: 'verified_current' | 'verified_reference';
  value: T;
  /** Field-specific evidence, never place freshness or mere ownership. */
  verifiedAt: string;
  source: Readonly<{ kind: 'gogo' | 'community' | 'google'; collectedAt: string }>;
}>;
export type PriceFact = Readonly<{
  min: number;
  max: number;
  currency: string;
  unit: 'per_person' | 'per_item' | 'per_hour' | 'per_night';
}>;
export type ScheduleInterval = Readonly<{
  kind: 'closed' | 'open_24h' | 'interval';
  openMinute?: number;
  closeMinute?: number;
  overnight?: boolean;
}>;
/** One complete weekday; every interval retains its actual field evidence.
 * Omit the weekday if completeness or any interval's policy/evidence is unknown.
 */
export type ScheduleFact = Readonly<{
  day: number;
  intervals: readonly VerifiedFact<ScheduleInterval>[];
}>;
export type TaxonomyFact = Readonly<{ key: string; labels: Readonly<{ vi: string; en: string }> }>;
export type PlaceFacts = Readonly<{
  id: string;
  available: boolean;
  /** Published canonical identity; unavailable rows expose no previous name. */
  name: string;
  facts: Readonly<{
    /** Exactly one complete schedule per weekday, with per-interval evidence. */
    hours?: readonly ScheduleFact[];
    /** Independently dated price rows and taxonomy assignments retain bundles. */
    price?: readonly VerifiedFact<readonly PriceFact[]>[];
    address?: VerifiedFact<string>;
    contact?: VerifiedFact<string>;
    amenity?: readonly VerifiedFact<readonly TaxonomyFact[]>[];
    suitability?: readonly VerifiedFact<readonly TaxonomyFact[]>[];
    overview?: readonly VerifiedFact<readonly TaxonomyFact[]>[];
    rating?: VerifiedFact<Readonly<{ source: 'community'; count: number; score: number | null }>>;
    /** Existing eligible provider read only; collection is NOT GoGo verification.
     * No graphical Google attribution in prose, so this can render only in
     * the existing attributed card contract. Reference/stale values omitted.
     */
    providerRating?: Readonly<{
      current: boolean;
      score: number;
      count: number;
      source: Readonly<{ kind: 'google'; collectedAt: string }>;
    }>;
    /** Present-time eligibility must be established independently by S2. */
    openNow?: VerifiedFact<boolean>;
  }>;
}>;
/** One immutable DB snapshot for the whole authorized group/page, never persisted. */
export type PlaceFactContext = Readonly<{ places: ReadonlyMap<string, PlaceFacts> }>;
export const PLACE_FACTS_READER = Symbol('PLACE_FACTS_READER');
/** S2 implements this port with ONE batched statement, no provider calls/caches.
 * All ids have been obtained from authorized stored messages. Omitted ids mean
 * unavailable; errors MUST reject (including DB cancellation), never return [].
 * Each field must pass rev3 §3.4, not just have a non-null DB value. No policy
 * path => omit. Abort/statement timeout must respect the absolute deadline.
 */
export interface PlaceFactsReader {
  placeFacts(
    ids: readonly string[],
    options: Readonly<{ signal: AbortSignal; deadlineAt: number }>,
  ): Promise<PlaceFactContext>;
}
export type RenderedSource = Readonly<{
  topic: AnswerTopic;
  verifiedAt: string;
  kind: 'gogo' | 'community';
  collectedAt: string;
}>;
