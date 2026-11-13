import { z } from 'zod';
import { MAX_INVITE_TTL_SECONDS } from '../../shared/invite-ttl';

export const updateRoomInviteSettingsSchema = z
  .object({ ttlSeconds: z.number().int().min(1).max(MAX_INVITE_TTL_SECONDS) })
  .strict();

export type UpdateRoomInviteSettings = z.infer<typeof updateRoomInviteSettingsSchema>;
