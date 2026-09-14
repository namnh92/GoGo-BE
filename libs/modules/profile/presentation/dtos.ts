import { administrativeAreaInput } from '../../administrative/application/area-selection';
import { z } from 'zod';
import {
  isAfterTodayInVietnam,
  isCalendarDate,
  todayInVietnam,
} from '../application/date-of-birth';

/**
 * PATCH /me (ADR-0022). `null` clears an optional field, an omitted field is
 * kept. `displayName` and `locale` are never null: a profile without a name
 * has no way to appear in a room. `strict()` on every object, so a client that
 * sends a kind or a field this contract does not carry hears about it instead
 * of having it dropped on the floor.
 */
export const profilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(50).optional(),
    locale: z.enum(['vi', 'en']).optional(),
    homeAdministrativeArea: administrativeAreaInput.nullable().optional(),
    homeAreaKey: z.string().trim().min(1).max(64).nullable().optional(),
    interests: z
      .object({ mood: z.array(z.string().trim().min(1).max(64)).max(20) })
      .strict()
      .nullable()
      .optional(),
    usualBudget: z
      .object({
        /** Integer minor units, per person. */
        perPerson: z.number().int().min(0).max(1_000_000_000_000),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .nullable()
      .optional(),
    /**
     * PROF-BE-013 (#573) — `YYYY-MM-DD`, a date that exists, not after today in
     * Asia/Ho_Chi_Minh. The issue code names the reason; the message never
     * echoes the value, since a validation error is the one place it could.
     */
    dateOfBirth: z
      .string()
      .superRefine((value, ctx) => {
        if (!isCalendarDate(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.invalid_date,
            message: 'must be a real calendar date as YYYY-MM-DD',
          });
          return;
        }
        const now = new Date();
        if (isAfterTodayInVietnam(value, now)) {
          ctx.addIssue({
            code: z.ZodIssueCode.too_big,
            type: 'date',
            maximum: Date.parse(`${todayInVietnam(now)}T00:00:00Z`),
            inclusive: true,
            message: 'cannot be after today in Asia/Ho_Chi_Minh',
          });
        }
      })
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.homeAreaKey === undefined || value.homeAdministrativeArea === undefined,
    { message: 'Send only one area representation', path: ['homeAdministrativeArea'] },
  );
export type ProfilePatchDto = z.infer<typeof profilePatchSchema>;

/** PUT /me/avatar — the key `POST /uploads { purpose: 'avatar' }` handed out. */
export const avatarPutSchema = z.object({ uploadKey: z.string().min(1).max(300) }).strict();
export type AvatarPutDto = z.infer<typeof avatarPutSchema>;
