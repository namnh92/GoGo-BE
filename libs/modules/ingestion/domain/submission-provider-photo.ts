import { z } from 'zod';
import { publicCatalogueUrl } from '../../shared/media-url';

export const submissionProviderPhotoSchema = z
  .object({
    provider: z.literal('google'),
    storageKey: z.string().regex(/^places\/provider\/[0-9a-f-]{36}\.(jpg|png|webp)$/),
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    fetchedAt: z.string().datetime(),
    sourceReference: z.string().min(1),
    attribution: z.literal('Google Maps'),
    authorAttributions: z.array(
      z
        .object({
          displayName: z.string(),
          uri: z.string().nullable(),
          photoUri: z.string().nullable(),
        })
        .strict(),
    ),
    googleMapsUri: z.string().nullable(),
    retiredAt: z.string().datetime().optional(),
    deleteAfter: z.string().datetime().optional(),
  })
  .strict();
export type StoredSubmissionPhoto = z.infer<typeof submissionProviderPhotoSchema>;
export function updateDeadline(
  status: string,
  decidedAt: Date | string | null | undefined,
): string | undefined {
  return status === 'rejected' && decidedAt
    ? new Date(new Date(decidedAt).getTime() + 7 * 86400_000).toISOString()
    : undefined;
}
/** Only projects a CDN cover. Never exposes the storage/retirement metadata. */
export function submissionPhotoView(
  raw: unknown,
  base: string | undefined,
  status = 'pending',
  decidedAt?: Date | string | null,
  now = Date.now(),
) {
  const parsed = submissionProviderPhotoSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const p = parsed.data;
  const deadline = updateDeadline(status, decidedAt);
  if (status === 'rejected' && (!deadline || Date.parse(deadline) <= now)) return undefined;
  if (p.deleteAfter && Date.parse(p.deleteAfter) <= now) return undefined;
  const url = publicCatalogueUrl(base, p.storageKey);
  if (!url) return undefined;
  return {
    id: p.storageKey.split('/').at(-1)!.split('.')[0]!,
    url,
    source: 'google' as const,
    attribution: p.attribution,
    authorAttributions: p.authorAttributions,
    googleMapsUri: p.googleMapsUri,
    ...(p.width ? { width: p.width } : {}),
    ...(p.height ? { height: p.height } : {}),
  };
}
