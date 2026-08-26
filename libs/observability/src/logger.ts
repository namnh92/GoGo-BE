import pino from 'pino';

/**
 * Security rule (.claude/rules/security.md): logs never contain tokens, secrets,
 * cookies, full payloads, raw exact location, or PII-bearing prompts.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.inviteCode',
  '*.secret',
  '*.email',
  '*.phone',
  '*.origin_lat',
  '*.origin_lng',
];

export type AppLogger = pino.Logger;

export function createLogger(opts: { level: string; name: string; pretty?: boolean }): AppLogger {
  return pino({
    name: opts.name,
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
      : {}),
  });
}
