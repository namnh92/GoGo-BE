import { z } from 'zod';

/**
 * Password policy: length is the primary control (NIST 800-63B); no
 * composition theatre beyond requiring it not be trivially short.
 */
export const passwordSchema = z.string().min(10).max(128);

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
