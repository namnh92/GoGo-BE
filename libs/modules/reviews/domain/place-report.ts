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
 * A blank note is no note: the queue shows "no note" rather than a row of
 * whitespace a moderator has to open to discover is empty.
 */
export const placeReportBodySchema = z.object({
  reasonCode: z.enum(PLACE_REPORT_REASONS),
  note: z
    .string()
    .max(PLACE_REPORT_NOTE_MAX)
    .optional()
    .transform((v) => {
      const trimmed = v?.trim();
      return trimmed ? trimmed : undefined;
    }),
});
export type PlaceReportBody = z.infer<typeof placeReportBodySchema>;
