import pino, { type DestinationStream } from 'pino';

/**
 * Security rule (.claude/rules/security.md): logs never contain tokens, secrets,
 * cookies, full payloads, raw exact location, or PII-bearing prompts.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  // SEC-004: the share-link Worker's shared token. The onRequest hook deletes
  // it before anything reads the request, so this is the second line of
  // defence — for an error path that captured headers earlier, or a future
  // caller that logs them before the hook has run.
  'req.headers["x-gogo-edge-auth"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  // pino's `*` matches one level of nesting only, so the top-level key is
  // named as well — an invite code logged as a bare field is still an invite.
  'inviteCode',
  '*.inviteCode',
  // LNK-BE-002: a share-link slug doubles as the room invite code.
  'slug',
  '*.slug',
  '*.secret',
  '*.email',
  '*.phone',
  '*.origin_lat',
  '*.origin_lng',
];

export type AppLogger = pino.Logger;
export type LogDestination = DestinationStream;

/**
 * Path segments that *are* credentials. `redact` works on object keys; a
 * credential inside `req.url` needs the URL rewritten before it is logged.
 *
 * - `/share-links/{slug}` (LNK-BE-002, #205): the slug is the public URL's only
 *   secret and, for a room invite, the code the app joins with. Every request
 *   log line for GET/DELETE carried it verbatim until this serializer existed.
 */
const CREDENTIAL_PATH_SEGMENTS: readonly RegExp[] = [/(\/share-links\/)[^/?#]+/g];

export function redactUrl(url: string): string {
  let out = url;
  for (const pattern of CREDENTIAL_PATH_SEGMENTS) out = out.replace(pattern, '$1[redacted]');
  return out;
}

type RequestLike = {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
};

/**
 * Replaces Fastify's default `req` serializer. Same fields, redacted URL.
 * Fastify merges the instance's own serializers over its defaults when it is
 * handed a `loggerInstance`, so defining it here covers `incoming request`,
 * `request completed` and every error line that attaches `req`.
 */
export function requestSerializer(req: RequestLike): Record<string, unknown> {
  return {
    method: req.method,
    url: req.url === undefined ? undefined : redactUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

export function createLogger(opts: {
  level: string;
  name: string;
  pretty?: boolean;
  /** Tests capture output here instead of stdout. Ignored with `pretty`. */
  destination?: DestinationStream;
}): AppLogger {
  const options: pino.LoggerOptions = {
    name: opts.name,
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: { req: requestSerializer },
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
      : {}),
  };
  return opts.destination && !opts.pretty ? pino(options, opts.destination) : pino(options);
}
