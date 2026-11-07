import { z } from 'zod';
import type { SubmissionDisplaySnapshot } from '@gogo/database';
import type { ResolvedProviderPlace } from '@gogo/providers';
import { normalizeGoogleAttribution } from '../../shared/attribution';

export const SUBMISSION_DISPLAY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// An allowlist also keeps raw provider data, photos and private input out of signed tokens/DB.
export const submissionDisplaySnapshotSchema = z.object({
  source: z.literal('google_places'),
  fetchedAt: z.string().datetime(),
  attributions: z.array(z.string().max(500)).max(10),
  googleMapsUri: z.string().max(2048).nullable(),
  name: z.string().max(1000),
  addressShort: z.string().max(2000),
  categoryKey: z.string().max(100).optional(),
  googleRating: z.number().min(0).max(5).nullable(),
  googleRatingCount: z.number().int().nonnegative(),
  openingHours: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        openMinute: z.number().int().min(0).max(1440),
        closeMinute: z.number().int().min(0).max(1440),
        isOvernight: z.boolean(),
      }),
    )
    .max(100),
});

export function snapshotFromDetails(
  details: ResolvedProviderPlace,
  categoryKey: string | null,
): SubmissionDisplaySnapshot {
  return submissionDisplaySnapshotSchema.parse({
    source: 'google_places',
    fetchedAt: new Date().toISOString(),
    attributions: [normalizeGoogleAttribution(details.attribution)],
    googleMapsUri: details.googleMapsUri,
    name: details.name,
    addressShort: details.shortAddress || details.addressText,
    ...(categoryKey ? { categoryKey } : {}),
    googleRating: details.rating,
    googleRatingCount: details.ratingCount,
    openingHours: details.hours,
  });
}

export function freshSnapshot(value: unknown): SubmissionDisplaySnapshot | undefined {
  const parsed = submissionDisplaySnapshotSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const age = Date.now() - Date.parse(parsed.data.fetchedAt);
  return age >= 0 && age <= SUBMISSION_DISPLAY_MAX_AGE_MS ? parsed.data : undefined;
}

/** Local BFF reference only. Actual photo/credit/availability come from the budgeted proxy. */
export function lazySubmissionPhoto(providerId: string) {
  return {
    url: `/v1/places/google-provider-photo/${encodeURIComponent(providerId)}`,
    provider: 'google' as const,
    attribution: 'Google Maps',
    authorAttributions: [],
    googleMapsUri: null,
  };
}
