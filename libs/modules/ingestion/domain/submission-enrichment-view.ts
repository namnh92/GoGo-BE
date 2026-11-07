// Read projection of #796. Strip unknown fields at every object boundary.
import { z } from 'zod';

const keys = (max: number, min = 0) =>
  z
    .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
    .min(min)
    .max(max)
    .refine((v) => new Set(v).size === v.length, 'Duplicate keys');
const rating = z.object({ rating: z.number().int().min(1).max(5), chipKeys: keys(5) }).strip();
export const submissionEnrichmentViewSchema = z
  .object({
    price: z
      .object({
        min: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        max: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        currency: z.literal('VND'),
        unit: z.enum(['per_person', 'per_group', 'per_item', 'per_hour', 'per_night', 'free']),
      })
      .strip()
      .refine(
        (p) => p.max >= p.min && (p.unit !== 'free' || (p.min === 0 && p.max === 0)),
        'Invalid price range',
      )
      .optional(),
    purposeKeys: keys(10).optional(),
    vibeKeys: keys(3).optional(),
    amenities: z
      .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.boolean())
      .refine((v) => Object.keys(v).length <= 6, 'At most six amenities')
      .optional(),
    photos: z
      .array(z.object({ mediaId: z.string().uuid(), kind: z.enum(['menu', 'bill']) }).strip())
      .max(5)
      .refine((v) => new Set(v.map((p) => p.mediaId)).size === v.length, 'Duplicate photos')
      .optional(),
    recommendedDishes: z.string().trim().max(1000).optional(),
    visitTips: z.string().trim().max(2000).optional(),
    service: rating.optional(),
    space: rating.optional(),
  })
  .strip();
