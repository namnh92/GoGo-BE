import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, redactUrl, requestSerializer } from './logger';
import { sanitizeRequest, sentryInitOptions } from './sentry';
import type { ErrorEvent } from '@sentry/node';

/**
 * GoGo-BE#717 A-R-12 — what a person searches in their own GoGo AI history
 * never lands in a request log or an error report. Marker-based: the marker
 * must not appear anywhere in what would be shipped.
 */
const MARKER = 'tim-lai-chuyen-rieng-tu-123';

describe('assistant conversation search is not kept in telemetry', () => {
  it('request logs drop `q` on the assistant search, keep it elsewhere', () => {
    const line = requestSerializer({
      method: 'GET',
      url: `/v1/assistant/conversations?limit=20&q=${MARKER}`,
    });
    expect(JSON.stringify(line)).not.toContain(MARKER);
    expect(line.url).toBe('/v1/assistant/conversations?limit=20&q=[redacted]');
    expect(redactUrl(`/v1/search?q=${MARKER}`)).toContain(MARKER);
  });

  it('error reports drop it from the URL and the separate query string', () => {
    const event = {
      request: {
        url: `https://api.gogo.vn/v1/assistant/conversations?q=${MARKER}`,
        method: 'GET',
        query_string: `q=${MARKER}&limit=20`,
      },
    } as ErrorEvent;
    const options = sentryInitOptions({ dsn: 'https://k@o.ingest.sentry.io/1', environment: 't' });
    const sent = options.beforeSend!(sanitizeRequest(event), {});
    expect(JSON.stringify(sent)).not.toContain(MARKER);
  });

  it('every q is redacted: repeated, percent-encoded key, in the URL and the query string (A-R2-10)', () => {
    for (const url of [
      `/v1/assistant/conversations?q=${MARKER}&q=other`,
      `/v1/assistant/conversations?q=other&q=${MARKER}`,
      `/v1/assistant/conversations?%71=${MARKER}`,
      `/v1/assistant/conversations?limit=5&%71=${MARKER}&cursor=abc`,
    ]) {
      expect(redactUrl(url)).not.toContain(MARKER);
    }
    const event = {
      request: {
        url: 'https://api.gogo.vn/v1/assistant/conversations?x=1',
        query_string: `%71=${MARKER}&q=${MARKER}`,
      },
    } as ErrorEvent;
    expect(JSON.stringify(sanitizeRequest(event))).not.toContain(MARKER);
  });
});

/**
 * GoGo-BE#742 F-01 — the CMS guide coverage check takes `question` in the URL;
 * it may be a user's message pasted by staff, and the endpoint promises it is
 * not stored. Marker-based like the search above.
 */
describe('guide coverage question is not kept in telemetry', () => {
  const QUESTION = 'cach-tao-phong-lien-he-an@example.com-0901234567';
  const ROUTE = '/v1/cms/assistant/guide-coverage';

  it('request logs drop `question` on the coverage route, keep the locale', () => {
    const line = requestSerializer({
      method: 'GET',
      url: `${ROUTE}?question=${QUESTION}&locale=vi`,
    });
    expect(JSON.stringify(line)).not.toContain(QUESTION);
    expect(line.url).toBe(`${ROUTE}?question=[redacted]&locale=vi`);
    // Another route's `question` is not this endpoint's promise.
    expect(redactUrl(`/v1/search?question=${QUESTION}`)).toContain(QUESTION);
  });

  it('every question is redacted: repeated, percent-encoded key, trailing slash', () => {
    for (const url of [
      `${ROUTE}?question=${QUESTION}&question=other`,
      `${ROUTE}?locale=vi&question=other&question=${QUESTION}`,
      `${ROUTE}?%71uestion=${QUESTION}`,
      `${ROUTE}?%71%75%65%73%74%69%6F%6E=${QUESTION}`,
      `${ROUTE}/?question=${QUESTION}`,
      `${ROUTE}?question=${encodeURIComponent('Cách tạo phòng? an@example.com')}`,
    ]) {
      expect(redactUrl(url)).not.toMatch(/example\.com|0901234567|C%C3%A1ch/);
    }
  });

  it('error reports drop it from the URL and the separate query string, in every form', () => {
    const options = sentryInitOptions({ dsn: 'https://k@o.ingest.sentry.io/1', environment: 't' });
    for (const query_string of [
      `question=${QUESTION}&locale=vi`,
      [
        ['question', QUESTION],
        ['locale', 'vi'],
      ],
      { question: QUESTION, locale: 'vi' },
    ]) {
      const event = {
        request: {
          url: `https://api.gogo.vn${ROUTE}?question=${QUESTION}`,
          method: 'GET',
          query_string,
        },
      } as ErrorEvent;
      const sent = options.beforeSend!(sanitizeRequest(event), {});
      expect(JSON.stringify(sent)).not.toContain(QUESTION);
      expect(JSON.stringify(sent)).toContain('vi');
    }
  });

  it('a real log line — request and error — never carries it', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = createLogger({ level: 'info', name: 'test', destination: sink });
    const url = `${ROUTE}?question=${QUESTION}&locale=vi`;
    logger.info({ req: { method: 'GET', url } }, 'request completed');
    logger.error({ err: new Error(`GET ${url} failed`) }, 'request errored');
    const out = lines.join('');
    expect(out).toContain('request completed');
    expect(out).toContain('question=[redacted]');
    expect(out).not.toContain(QUESTION);
  });

  it('a log line that quotes the URL is redacted too', () => {
    expect(redactUrl(`GET ${ROUTE}?question=${QUESTION} failed`)).not.toContain(QUESTION);
  });
});
