/** Account policy is always 23:00 <= local time < 07:00, default OFF.
 * UTC instants are tested against IANA local time. Searching forward on the UTC
 * timeline chooses the first non-quiet instant across skipped/repeated DST times;
 * never add eight UTC hours (a local night need not be eight hours).
 */
export type QuietHours = { enabled: boolean; timezone: string | null };
export function validTimezone(value: string): boolean {
  if (value !== 'UTC' && !/^[A-Za-z_+-]+\/[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
export function quietHoursEnd(now: Date, settings: QuietHours): Date | null {
  if (!settings.enabled || !settings.timezone) return null;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const quiet = (instant: number) => {
    const hour = Number(formatter.format(instant));
    return hour >= 23 || hour < 7;
  };
  if (!quiet(now.getTime())) return null;
  const minute = 60_000;
  for (
    let instant = Math.floor(now.getTime() / minute) * minute + minute;
    instant <= now.getTime() + 48 * 60 * minute;
    instant += minute
  ) {
    if (!quiet(instant)) return new Date(instant);
  }
  throw new Error('QUIET_HOURS_BOUNDARY_NOT_FOUND');
}
