import { z } from 'zod';

const keys = (max: number, min = 0) =>
  z
    .array(z.string().min(1).max(64))
    .min(min)
    .max(max)
    .refine((v) => new Set(v).size === v.length, 'Duplicate keys');
const rating = z.object({ rating: z.number().int().min(1).max(5), chipKeys: keys(5) }).strict();
export const enrichmentDraftSchema = z
  .object({
    price: z
      .object({
        min: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        max: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        currency: z.literal('VND'),
        unit: z.enum(['per_person', 'per_group', 'per_item', 'per_hour', 'per_night', 'free']),
      })
      .strict()
      .refine(
        (p) => p.max >= p.min && (p.unit !== 'free' || (p.min === 0 && p.max === 0)),
        'Invalid price range',
      )
      .optional(),
    purposeKeys: keys(10).optional(),
    vibeKeys: keys(3).optional(),
    amenities: z
      .record(z.string().min(1).max(64), z.boolean())
      .refine((v) => Object.keys(v).length <= 6, 'At most six amenities')
      .optional(),
    billPhotoPublicConsent: z.boolean().optional(),
    photos: z
      .array(
        z
          .object({
            mediaId: z.string().uuid(),
            kind: z.enum(['menu', 'bill']),
          })
          .strict(),
      )
      .max(5)
      .refine((v) => new Set(v.map((p) => p.mediaId)).size === v.length, 'Duplicate photos')
      .optional(),
    recommendedDishes: z.string().trim().max(1000).optional(),
    visitTips: z.string().trim().max(2000).optional(),
    service: rating.optional(),
    space: rating.optional(),
  })
  .strict();

export const enrichmentSchema = enrichmentDraftSchema.extend({
  purposeKeys: keys(10, 1),
  vibeKeys: keys(3, 1),
  service: rating,
  space: rating,
});
export const saveContributionDraftSchema = z
  .object({
    googlePlaceId: z.string().trim().min(5).max(255),
    expectedVersion: z.number().int().min(0),
    enrichment: enrichmentDraftSchema,
  })
  .strict();
export type SaveContributionDraft = z.infer<typeof saveContributionDraftSchema>;
