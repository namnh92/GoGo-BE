/**
 * GoGo-BE#713 Q1 — per-account allowance: N accepted messages per local day
 * (Asia/Ho_Chi_Minh) and M in any rolling minute. Provisional, configurable;
 * an unset limit refuses rather than meaning unlimited.
 */

/** Asia/Ho_Chi_Minh is UTC+7 all year (no daylight saving). */
const VN_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
export const BURST_WINDOW_MS = 60_000;

/** Start of the current local day, as a UTC instant. */
export function vnDayStart(now: Date): Date {
  const local = now.getTime() + VN_OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - VN_OFFSET_MS);
}

/** Next local midnight (when `remainingToday` refills), as a UTC instant. */
export function vnNextReset(now: Date): Date {
  return new Date(vnDayStart(now).getTime() + DAY_MS);
}

/** First instant of the current UTC month — the spend ceiling's period. */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export type AssistantLimits = {
  dailyMessageLimit: number;
  messagesPerMinuteLimit: number;
};

export type AllowanceUsage = {
  acceptedToday: number;
  /** Accepted sends in the rolling minute, oldest first. */
  burstAcceptedAt: Date[];
};

export type AllowanceDecision =
  | { ok: true; remainingToday: number }
  | { ok: false; code: 'ASSISTANT_DAILY_LIMIT'; retryAfterSeconds: number }
  | { ok: false; code: 'RATE_LIMITED'; retryAfterSeconds: number };

/** Daily first: a spent day is not fixed by waiting a minute. */
export function decideAllowance(
  limits: AssistantLimits,
  usage: AllowanceUsage,
  now: Date,
): AllowanceDecision {
  if (usage.acceptedToday >= limits.dailyMessageLimit) {
    return {
      ok: false,
      code: 'ASSISTANT_DAILY_LIMIT',
      retryAfterSeconds: secondsUntil(vnNextReset(now), now),
    };
  }
  if (usage.burstAcceptedAt.length >= limits.messagesPerMinuteLimit) {
    // The window frees a slot when its oldest counted send ages out.
    const oldest =
      usage.burstAcceptedAt[usage.burstAcceptedAt.length - limits.messagesPerMinuteLimit];
    const freesAt = new Date((oldest ?? now).getTime() + BURST_WINDOW_MS);
    return { ok: false, code: 'RATE_LIMITED', retryAfterSeconds: secondsUntil(freesAt, now) };
  }
  return { ok: true, remainingToday: limits.dailyMessageLimit - usage.acceptedToday };
}

function secondsUntil(at: Date, now: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 1000));
}
