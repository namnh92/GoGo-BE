import { AppError } from './app-error';

/**
 * The one place an operator-supplied URL is checked.
 *
 * A link an operator types goes out to tens of thousands of phones at once: a
 * link to an internal address turns that into a request flood against our own
 * network, and a link carrying credentials leaks them into every device's
 * history. `.claude/rules/security.md` requires SSRF and open-redirect defence
 * wherever a URL is accepted from an operator, and campaigns and banners must
 * not each have their own idea of what that means.
 */
const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i;

export function assertExternalUrl(value: string, field = 'destinationValue'): string {
  const reject = (message: string): never => {
    throw AppError.badRequest('INVALID_DESTINATION', 'That destination cannot be used', [
      { field, code: 'invalid', message },
    ]);
  };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject('must be an absolute URL');
  }
  if (url.protocol !== 'https:') return reject('must be https');
  if (url.username || url.password) return reject('must not carry credentials');
  if (PRIVATE_HOST.test(url.hostname)) return reject('must not point inside the network');
  return url.toString();
}
