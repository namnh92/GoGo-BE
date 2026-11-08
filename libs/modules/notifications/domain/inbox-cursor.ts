import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/app-error';

function validInstant(value: string): boolean {
  const milliseconds = value.replace(/(\.\d{3})\d*Z$/, '$1Z');
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === milliseconds;
}

const instant = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/)
  .refine(validInstant);
const positionSchema = z.object({ createdAt: instant, id: z.string().uuid() });
type InboxPosition = z.infer<typeof positionSchema>;

// Pre-cutover pagination must include unsequenced historical rows and remain
// available without signing material, like the legacy timestamp path. Keep
// this mode explicit so activation cannot turn it into a sequence snapshot.
export function fallbackInboxCursor(position: InboxPosition): string {
  return `before:${position.createdAt}:${position.id}`;
}
export function fallbackInboxPosition(raw: string): InboxPosition | null {
  const match = /^before:(.+):([\da-f-]+)$/i.exec(raw);
  if (!match) return null;
  const parsed = positionSchema.safeParse({ createdAt: match[1], id: match[2] });
  return parsed.success ? parsed.data : null;
}
const tokenSchema = z.object({
  v: z.literal(1),
  account: z.string().uuid(),
  cutoff: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  asOf: instant,
  expires: z.number().int(),
  type: z.enum(['through', 'page']),
  filter: z.literal('all'),
  before: positionSchema.optional(),
});
export type InboxCursor = z.infer<typeof tokenSchema>;
export const INBOX_CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const invalid = () =>
  AppError.badRequest('INVALID_NOTIFICATION_CURSOR', 'Invalid notification cursor');

/** Domain-separated MAC, fixed schema and purpose, account/filter binding. Never log tokens. */
export class InboxCursorCodec {
  private readonly key: Buffer | null;
  constructor(secret: string) {
    this.key =
      secret.length >= 32
        ? createHmac('sha256', secret).update('gogo.notification-inbox.v1').digest()
        : null;
  }
  seal(value: InboxCursor): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${this.mac(body).toString('base64url')}`;
  }
  open(raw: string, account: string, type: InboxCursor['type'], now = Date.now()): InboxCursor {
    if (raw.length > 2048) throw invalid();
    const parts = raw.split('.');
    if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) throw invalid();
    const expected = this.mac(parts[0]!);
    const given = Buffer.from(parts[1]!, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    } catch {
      throw invalid();
    }
    const parsed = tokenSchema.safeParse(decoded);
    if (!parsed.success) throw invalid();
    const value = parsed.data;
    if (value.account !== account || value.type !== type || (type === 'page' && !value.before))
      throw invalid();
    if (value.expires <= now)
      throw AppError.gone('NOTIFICATION_CURSOR_EXPIRED', 'Notification cursor expired');
    return value;
  }
  private mac(body: string): Buffer {
    if (!this.key)
      throw AppError.serviceUnavailable(
        'NOTIFICATION_INBOX_UNAVAILABLE',
        'Inbox signing unavailable',
        false,
      );
    return createHmac('sha256', this.key).update(body).digest();
  }
}

/** Accept only the timestamp format the old endpoint actually issued. */
export function legacyInboxTimestamp(raw: string): string | null {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw) && validInstant(raw) ? raw : null;
}
