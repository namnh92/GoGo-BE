/**
 * Where a public object is readable, or null when media hosting is not
 * configured in this environment (`MEDIA_PUBLIC_BASE_URL` empty).
 *
 * One function, because the same composition was about to be written for the
 * third time — profile, member list, cleanup purge — and three copies of "base
 * plus key" drift the day one of them learns about a CDN prefix. An honest
 * null beats a URL that would 404: every client falls back to initials.
 */
export function publicMediaUrl(
  base: string | undefined,
  key: string | null | undefined,
): string | null {
  const trimmed = base?.replace(/\/$/, '');
  return trimmed && key ? `${trimmed}/${key.replace(/^\//, '')}` : null;
}
