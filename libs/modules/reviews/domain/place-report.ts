import { z } from 'zod';

/**
 * BE-BFF-P2 (#218) — what a person may say is wrong about a place.
 *
 * Stable keys, never sentences: the client resolves the label through i18n and
 * the moderation queue filters on the key. The set mirrors the facts Place
 * Detail shows (hours, price, location, whether it still operates) plus a
 * catch-all. The contract declares it `x-extensible-enum`, so adding a key is
 * not a breaking change for a client that renders an unknown one generically.
 */
export const PLACE_REPORT_REASONS = [
  'wrong_hours',
  'wrong_price',
  'wrong_location',
  'permanently_closed',
  'other',
] as const;
export type PlaceReportReason = (typeof PLACE_REPORT_REASONS)[number];

/** Long enough to say what is wrong; short enough that it is not a document. */
export const PLACE_REPORT_NOTE_MAX = 500;

/**
 * Control characters a person does not type: C0 except tab and line feed, DEL,
 * and C1. NUL in particular cannot be stored in a Postgres `text` column and
 * used to surface as a retryable 500 (GoGo-BE#662 F-03).
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

/**
 * The note is trimmed **before** the length cap, so surrounding whitespace never
 * pushes a 500-character note over it. A Windows line ending is normalised to
 * a line feed first, so pasted text is not refused for its carriage returns.
 * A blank note is no note: the queue shows "no note" rather than a row of
 * whitespace a moderator has to open to discover is empty.
 */
export const placeReportBodySchema = z.object({
  reasonCode: z.enum(PLACE_REPORT_REASONS),
  note: z
    .string()
    .transform((v) => v.replace(/\r\n/g, '\n'))
    .pipe(
      z
        .string()
        .trim()
        .max(PLACE_REPORT_NOTE_MAX)
        .refine((v) => !FORBIDDEN_CONTROL.test(v), {
          message: 'Note must not contain control characters other than tab and line feed',
        }),
    )
    .optional()
    .transform((v) => (v ? v : undefined)),
});
export type PlaceReportBody = z.infer<typeof placeReportBodySchema>;
