import { z } from 'zod';
import { SHARE_LINK_TYPES, SHARE_SLUG_PATTERN } from '../domain/share-link';

/** Bounded vocabularies a sharing surface names, e.g. `room_share`, `zalo`. */
const utmToken = z.string().regex(/^[a-z0-9_]{1,40}$/);

export const createShareLinkSchema = z.object({
  type: z.enum(SHARE_LINK_TYPES),
  /** Every P0 target is a UUID; the REFERRAL contract will widen this. */
  entityId: z.string().uuid(),
  source: utmToken.optional(),
  medium: utmToken.optional(),
  campaign: utmToken.optional(),
});
export type CreateShareLinkDto = z.infer<typeof createShareLinkSchema>;

export const shareSlugSchema = z.string().regex(SHARE_SLUG_PATTERN);
