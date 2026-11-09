import { z } from 'zod';
import { AppError } from '../../shared/app-error';

// Only canonical routes understood by the app. No credentials, query, fragment,
// encoded path, external URL, alias or arbitrary scheme can enter public copy.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const SYSTEM_DEEP_LINK_PATTERN = `^gogo://(?:(?:place|room|plan)/${UUID}|invite/[A-Za-z0-9_-]{6,64}|l/[A-Za-z0-9_-]{4,32}|saved|notifications|profile)$`;
export const systemAnnouncementInput = z
  .object({
    kind: z.enum(['maintenance', 'update', 'general']),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10000),
    locale: z.literal('vi').optional(),
    deepLink: z.string().regex(new RegExp(SYSTEM_DEEP_LINK_PATTERN)).nullable().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .strict();
export const systemAnnouncementPatch = systemAnnouncementInput
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const systemNotificationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(2048).optional(),
});
export const cmsSystemNotificationQuery = systemNotificationQuery.extend({
  status: z.enum(['draft', 'published', 'archived']).optional(),
});
export type SystemAnnouncementInput = z.infer<typeof systemAnnouncementInput>;
export type SystemAnnouncementPatch = z.infer<typeof systemAnnouncementPatch>;
export type SystemNotificationQuery = z.infer<typeof cmsSystemNotificationQuery>;

// Preserve PostgreSQL microseconds. The purpose prevents a CMS createdAt cursor
// from accidentally being used as a public publishedAt cursor.
const position = z.tuple([z.enum(['public', 'cms']), z.string().datetime(), z.string().uuid()]);
export function systemNotificationCursor(at: string, id: string, purpose: 'public' | 'cms') {
  return Buffer.from(JSON.stringify([purpose, at, id])).toString('base64url');
}
export function parseSystemNotificationCursor(cursor: string, purpose: 'public' | 'cms') {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('encoding');
    const [scope, at, id] = position.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()));
    if (scope !== purpose) throw new Error('purpose');
    return { at, id };
  } catch {
    throw AppError.badRequest('INVALID_CURSOR', 'Cursor is not valid');
  }
}

/** If-None-Match uses weak comparison for GET and accepts a list or wildcard. */
export function matchesSystemNotificationEtag(header: string | undefined, etag: string): boolean {
  return (
    header
      ?.split(',')
      .some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag) ?? false
  );
}
