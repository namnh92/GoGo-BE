import { z } from 'zod';

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
  })
  .strict();
export type ProfilePatchDto = z.infer<typeof profilePatchSchema>;

/** PUT /me/avatar — the key `POST /uploads { purpose: 'avatar' }` handed out. */
export const avatarPutSchema = z.object({ uploadKey: z.string().min(1).max(300) }).strict();
export type AvatarPutDto = z.infer<typeof avatarPutSchema>;
