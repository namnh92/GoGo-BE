import { z } from 'zod';

// Unicode case supports Vietnamese keyboards; length keeps login's UTF-16 cap.
export const passwordSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/\p{Lu}/u, 'Password must contain an uppercase letter')
  .regex(/\p{Ll}/u, 'Password must contain a lowercase letter')
  .regex(/[0-9]/, 'Password must contain a digit (0-9)')
  .regex(/[^\p{L}\p{N}\p{M}]/u, 'Password must contain a special character');

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(50),
  claimGuestToken: z.string().min(20).max(128).optional(),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(128).optional(),
  guestToken: z.string().min(20).max(128).optional(),
});
export type RefreshDto = z.infer<typeof refreshSchema>;

export const guestSessionSchema = z.object({
  roomCode: z.string().trim().min(6).max(64),
  displayName: z.string().trim().min(1).max(50),
});
export type GuestSessionDto = z.infer<typeof guestSessionSchema>;

export const logoutSchema = z.object({
  allDevices: z.boolean().default(false),
});
export type LogoutDto = z.infer<typeof logoutSchema>;
