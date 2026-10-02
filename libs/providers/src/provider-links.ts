/**
 * GoGo-BE#509 — validation for provider links a client will open or load.
 *
 * Its own module so the hostnames below are not read as operation labels by
 * the cost audit that scans adapter sources for `google.*` literals.
 */

/** Hosts a credit link or an image URL may point at. Suffix match on labels. */
export const LINK_HOSTS = ['google.com', 'googleusercontent.com', 'ggpht.com'] as const;
export const IMAGE_HOSTS = ['googleusercontent.com', 'ggpht.com'] as const;

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

/**
 * A provider link a client may open or load, or `null` (GoGo-BE#509).
 *
 * Google sends credit links scheme-relative (`//maps.google.com/maps/contrib/…`),
 * so those become `https:`. Everything else must already be `https:` on a
 * Google host with no userinfo: a `javascript:` or `data:` value, a plain-http
 * link, or a link to anywhere else is dropped rather than handed to a client
 * that will put it behind a tap.
 */
export function safeProviderUri(
  value: unknown,
  allowed: readonly string[] = LINK_HOSTS,
): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 2048) return null;
  const candidate = value.startsWith('//') ? `https:${value}` : value;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '' && url.port !== '443') return null;
  if (!hostAllowed(url.hostname, allowed)) return null;
  return url.toString();
}
