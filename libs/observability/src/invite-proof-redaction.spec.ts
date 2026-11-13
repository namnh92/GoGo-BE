import { describe, expect, it } from 'vitest';
import { createLogger, errorSerializer } from './logger';
import { redactCoordinatesDeep } from './telemetry-redaction';
import { sanitizeRequest, sentryInitOptions } from './sentry';
import type { ErrorEvent } from '@sentry/node';
import { redactInviteProofsDeep, redactInviteProofText } from './invite-proof-redaction';
const PROOF = 'private-invite-context-proof-marker';
const CSRF = 'private-invite-csrf-marker';
describe('I05 proof privacy at telemetry sinks', () => {
  it('removes nested bodies, headers and text echoes without a one-level wildcard', () => {
    const data = {
      nested: {
        body: { contextToken: PROOF, csrfToken: CSRF },
        headers: { 'x-gogo-invite-context': PROOF, 'x-gogo-invite-csrf': CSRF },
        tuple: ['contextToken', PROOF],
      },
      message: `contextToken=${PROOF} csrfToken: ${CSRF}`,
    };
    for (const result of [redactInviteProofsDeep(data), redactCoordinatesDeep(data)]) {
      expect(JSON.stringify(result)).not.toContain(PROOF);
      expect(JSON.stringify(result)).not.toContain(CSRF);
    }
    expect(redactInviteProofText(`{"contextToken":"${PROOF}"}`)).not.toContain(PROOF);
  });
  it('Pino deep fields, SQL error parameters and message echoes never contain proof', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      name: 'i05-test',
      destination: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    });
    logger.info({ nested: { payload: { contextToken: PROOF, csrfToken: CSRF } } }, 'safe');
    logger.info({ echo: `x-gogo-invite-context: ${PROOF}` });
    const error = Object.assign(new Error(`Failed query\nparams: ${PROOF},${CSRF}`), {
      params: [PROOF, CSRF],
    });
    expect(JSON.stringify(errorSerializer(error))).not.toContain(PROOF);
    expect(lines.join()).not.toContain(PROOF);
    expect(lines.join()).not.toContain(CSRF);
  });
  it('Sentry drops proof headers, cookies and response/body details, deep breadcrumb values redact', () => {
    const result = redactCoordinatesDeep(
      sanitizeRequest({
        request: {
          url: 'https://api.gogo.id.vn/v1/invite-attempt-contexts',
          method: 'POST',
          data: { contextToken: PROOF },
          cookies: { __Host_gogo_invite_ctx: PROOF },
          headers: {
            'x-gogo-invite-context': PROOF,
            'x-gogo-invite-csrf': CSRF,
            'content-type': 'application/json',
          },
        },
        breadcrumbs: [{ data: { nested: { contextToken: PROOF, csrfToken: CSRF } } }],
      }),
    );
    expect(JSON.stringify(result)).not.toContain(PROOF);
    expect(JSON.stringify(result)).not.toContain(CSRF);
    expect(result.request?.headers?.['content-type']).toBe('application/json');
  });
});

describe('I05 decoded query names (F-02)', () => {
  const queries = [
    `%63ontextToken=${PROOF}&locale=vi`,
    `%63%6f%6e%74%65%78%74%54%6f%6b%65%6e=${PROOF}&locale=vi`,
    `contextToken=first&%63ontextToken=${PROOF}&contextToken=${CSRF}&locale=vi`,
    `%43ONTEXTtoken=${PROOF}&%63srfToken=${CSRF}&locale=vi`,
    `%78-gogo-invite-context=${PROOF}&cookieProof=${CSRF}&locale=vi`,
    `__Host-gogo_invite_%63tx=${PROOF}&headerProof=${CSRF}&locale=vi`,
  ];
  it.each(queries)('Pino serializes decoded proof names safely: %s', (query) => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      name: 'query',
      destination: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    });
    // Incoming requests are logged before any controller/transport validation.
    logger.info(
      { req: { method: 'GET', url: `/v1/invite-attempt-contexts?${query}` } },
      'incoming request',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(PROOF);
    expect(lines[0]).not.toContain(CSRF);
    expect(lines[0]).toContain('locale=vi');
  });
  it.each(queries)(
    'Sentry scrubber and beforeSend cover every query_string form: %s',
    async (query) => {
      const pairs = query.split('&').map((pair) => pair.split('='));
      const options = sentryInitOptions({
        dsn: 'https://k@o.ingest.sentry.io/1',
        environment: 'test',
      });
      for (const query_string of [query, `?${query}`, pairs, Object.fromEntries(pairs)]) {
        const event = {
          request: { url: `https://api.gogo.vn/v1/invite-attempt-contexts?${query}`, query_string },
        } as ErrorEvent;
        for (const result of [sanitizeRequest(event), await options.beforeSend!(event, {})]) {
          expect(JSON.stringify(result)).not.toContain(PROOF);
          expect(JSON.stringify(result)).not.toContain(CSRF);
          expect(JSON.stringify(result)).toContain('vi');
        }
      }
    },
  );
  it.each(['%ZZontextToken', '%', '%E0%A4%A', '%C0%AF'])(
    'malformed names fail closed at both sinks: %s',
    async (key) => {
      const query = `locale=vi&${key}=${PROOF}`;
      const lines: string[] = [];
      const logger = createLogger({
        level: 'info',
        name: 'malformed',
        destination: {
          write: (line: string) => {
            lines.push(line);
          },
        },
      });
      logger.info({ req: { url: `/v1/invite-attempt-contexts?${query}` } }, 'incoming request');
      expect(JSON.parse(lines[0]!).req.url).toBe('/v1/invite-attempt-contexts?[redacted]');
      const options = sentryInitOptions({
        dsn: 'https://k@o.ingest.sentry.io/1',
        environment: 'test',
      });
      for (const query_string of [
        query,
        [
          ['locale', 'vi'],
          [key, PROOF],
        ],
        { locale: 'vi', [key]: PROOF },
      ]) {
        const event = {
          request: { url: `https://api.gogo.vn/v1/invite-attempt-contexts?${query}`, query_string },
        } as ErrorEvent;
        const sent = JSON.stringify(await options.beforeSend!(event, {}));
        expect(sent).not.toContain(PROOF);
        expect(sent).not.toContain('vi&');
        expect(sent).not.toContain('locale');
      }
    },
  );
  it('keeps unrelated query names and text, including proof-name suffix lookalikes', () => {
    const text = `/v1/search?q=${PROOF}&notcontextToken=${CSRF}&contextTokenHint=public&context+Token=public`;
    expect(redactInviteProofText(text)).toBe(text);
    expect(redactInviteProofText('ordinary message: keep this')).toBe(
      'ordinary message: keep this',
    );
  });
  it('redacts the whole malformed query, including valueless keys and invalid values', () => {
    for (const query of [`%GG&contextToken=${PROOF}`, `%GG`, `q=%FF&contextToken=${PROOF}`]) {
      expect(redactInviteProofText(`/v1/invite-attempt-contexts?${query}#section`)).toBe(
        '/v1/invite-attempt-contexts?[redacted]#section',
      );
    }
  });
});

describe('I05 serialized Pino messages (F-03)', () => {
  it('redacts separate messages, interpolation, child loggers and error messages after formatting', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'trace',
      name: 'message',
      destination: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    });
    logger.info({}, `contextToken=${PROOF}`);
    logger.info(`csrfToken=${CSRF}`);
    logger.warn({}, 'contextToken=%s', PROOF);
    logger.child({ component: 'invite' }).error({}, '%s=%s', 'contextToken', PROOF);
    logger.error(new Error(`contextToken=${PROOF}`));
    logger.info({}, `GET /v1/invite-attempt-contexts?%63ontextToken=${PROOF}&locale=vi rejected`);
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).not.toContain(PROOF);
      expect(line).not.toContain(CSRF);
      expect(JSON.parse(line).msg).toContain('[redacted]');
    }
    logger.info({}, `q=${PROOF}&notcontextToken=${CSRF}`);
    expect(JSON.parse(lines.at(-1)!).msg).toBe(`q=${PROOF}&notcontextToken=${CSRF}`);
  });
});
