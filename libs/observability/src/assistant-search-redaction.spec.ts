import { describe, expect, it } from 'vitest';
import { redactUrl, requestSerializer } from './logger';
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
