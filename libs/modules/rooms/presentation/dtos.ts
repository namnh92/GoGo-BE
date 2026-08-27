import { z } from 'zod';

export const uuidSchema = z.string().uuid();

const constraintFields = {
  originText: z.string().trim().max(200).optional(),
  originLat: z.number().min(-90).max(90).optional(),
  originLng: z.number().min(-180).max(180).optional(),
  areaKey: z.string().trim().max(64).optional(),
  radiusM: z.number().int().min(100).max(50_000).optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  budgetMode: z.enum(['total', 'per_person']),
  budgetAmount: z.number().int().min(0).max(1_000_000_000_000),
  currency: z.string().length(3).default('VND'),
  dietaryKeys: z.array(z.string().max(64)).max(20).default([]),
  accessibilityKeys: z.array(z.string().max(64)).max(20).default([]),
};

const constraintSchema = z
  .object(constraintFields)
  .refine((c) => !c.startAt || !c.endAt || c.startAt < c.endAt, {
    message: 'startAt must be before endAt',
    path: ['startAt'],
  });

export const createRoomSchema = z.object({
  type: z.enum(['couple', 'group']),
  decisionMode: z.enum(['match', 'vote', 'host']),
  participantCount: z.number().int().min(2).max(20),
  title: z.string().trim().max(80).optional(),
  scheduledDate: z.coerce.date().optional(),
  constraint: constraintSchema,
  seedPlaceIds: z.array(uuidSchema).max(10).default([]),
});
export type CreateRoomDto = z.infer<typeof createRoomSchema>;

export const updateConstraintsSchema = z
  .object({
    ...constraintFields,
    expectedConstraintVersion: z.number().int().min(1),
    participantCount: z.number().int().min(2).max(20).optional(),
  })
  .refine((c) => !c.startAt || !c.endAt || c.startAt < c.endAt, {
    message: 'startAt must be before endAt',
    path: ['startAt'],
  });
export type UpdateConstraintsDto = z.infer<typeof updateConstraintsSchema>;

export const transitionSchema = z.object({
  status: z.enum([
    'draft',
    'collecting',
    'matching',
    'ready',
    'active',
    'completed',
    'cancelled',
    'expired',
  ]),
});
export type TransitionDto = z.infer<typeof transitionSchema>;

export const createInviteSchema = z.object({
  maxUses: z.number().int().min(1).max(100).optional(),
});
export type CreateInviteDto = z.infer<typeof createInviteSchema>;

export const joinRoomSchema = z.object({
  inviteCode: z.string().trim().min(10).max(128),
});
export type JoinRoomDto = z.infer<typeof joinRoomSchema>;

export const guestJoinSchema = z.object({
  inviteCode: z.string().trim().min(10).max(128),
  displayName: z.string().trim().min(1).max(50),
});
export type GuestJoinDto = z.infer<typeof guestJoinSchema>;

export const seedPlacesSchema = z.object({
  placeIds: z.array(uuidSchema).min(1).max(10),
});
export type SeedPlacesDto = z.infer<typeof seedPlacesSchema>;
