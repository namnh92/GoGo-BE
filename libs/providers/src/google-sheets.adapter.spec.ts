import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleSheetsAdapter } from './google-sheets.adapter';
import { ProviderQuotaExceededError, SheetAccessError } from './ports';
import { resetBreakers } from './resilience';

const API_KEY = 'AIzaSyExampleNotARealCredential0000000000';

/**
 * The live response from DEV on 2026-08-31, trimmed to the fields the adapter
 * reads. Kept verbatim rather than hand-written: the whole defect was that the
 * shape of this body was never looked at.
 */
const SERVICE_DISABLED_BODY = {
  error: {
    code: 403,
    message:
      'Google Sheets API has not been used in project 186055730568 before or it is disabled.',
    status: 'PERMISSION_DENIED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'SERVICE_DISABLED',
        domain: 'googleapis.com',
        metadata: {
          service: 'sheets.googleapis.com',
          consumer: 'projects/186055730568',
          activationUrl:
            'https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=186055730568',
        },
      },
    ],
  },
};

/** A sheet that exists and simply was not shared — no ErrorInfo reason at all. */
const NOT_SHARED_BODY = {
  error: {
    code: 403,
    message: 'The caller does not have permission',
    status: 'PERMISSION_DENIED',
  },
};

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe('PI-BE-022 — GoogleSheetsAdapter failure mapping', () => {
  beforeEach(() => {
    resetBreakers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads SERVICE_DISABLED as our misconfiguration, not their permissions', async () => {
    respond(403, SERVICE_DISABLED_BODY);
    const adapter = new GoogleSheetsAdapter(API_KEY);

    await expect(adapter.listTabs('book-1')).rejects.toMatchObject({
      code: 'SHEET_PROVIDER_NOT_CONFIGURED',
      providerReason: 'SERVICE_DISABLED',
    });
  });

  it('still reads a bare 403 as a permission problem with the sheet', async () => {
    respond(403, NOT_SHARED_BODY);
    const adapter = new GoogleSheetsAdapter(API_KEY);

    await expect(adapter.listTabs('book-1')).rejects.toMatchObject({
      code: 'SHEET_PERMISSION_DENIED',
    });
  });

  it('reads a blocked or invalid key as our misconfiguration whatever the status', async () => {
    for (const [status, reason] of [
      [403, 'API_KEY_SERVICE_BLOCKED'],
      [400, 'API_KEY_INVALID'],
    ] as const) {
      resetBreakers();
      respond(status, {
        error: {
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }],
        },
      });
      const adapter = new GoogleSheetsAdapter(API_KEY);

      // The 400 case is the one that used to read "Tab không tồn tại trong
      // sheet" — an invalid key reported as a missing tab.
      await expect(adapter.listTabs('book-1')).rejects.toMatchObject({
        code: 'SHEET_PROVIDER_NOT_CONFIGURED',
        providerReason: reason,
      });
    }
  });

  it('never leaks the project number, the activation URL or the key', async () => {
    respond(403, SERVICE_DISABLED_BODY);
    const adapter = new GoogleSheetsAdapter(API_KEY);

    const err = await adapter.listTabs('book-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SheetAccessError);
    const message = (err as SheetAccessError).message;

    // The message is what the CMS renders to an editor. Google's body names our
    // GCP project and links its console; none of that is theirs to see.
    expect(message).not.toContain('186055730568');
    expect(message).not.toContain('console.developers.google.com');
    expect(message).not.toContain(API_KEY);
    expect(message).toBe('GoGo chưa cấu hình kết nối Google Sheets');
  });

  it('falls back to the status when the body carries no reason', async () => {
    resetBreakers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>gateway</html>', { status: 404 })),
    );
    const adapter = new GoogleSheetsAdapter(API_KEY);

    // A body that is not JSON must not turn a mapped failure into a generic
    // one: the error path may not fail at reading its own error.
    await expect(adapter.listTabs('book-1')).rejects.toMatchObject({
      code: 'SHEET_NOT_FOUND',
    });
  });

  it('keeps 429 a quota error rather than a sheet error', async () => {
    respond(429, { error: { status: 'RESOURCE_EXHAUSTED' } });
    const adapter = new GoogleSheetsAdapter(API_KEY);

    await expect(adapter.listTabs('book-1')).rejects.toBeInstanceOf(ProviderQuotaExceededError);
  });
});

/**
 * #321 — the Sheets adapter was the only Google adapter emitting nothing, so a
 * CMS row for it could show no calls, no failure rate and no latency. A
 * dashboard rendering that as zero reads as "nobody used it" rather than
 * "nobody measured it".
 */
describe('#321 — Sheets metrics', () => {
  function recorder() {
    const counters: { name: string; labels: Record<string, unknown> }[] = [];
    const observations: { name: string; value: number; labels: Record<string, unknown> }[] = [];
    return {
      counters,
      observations,
      named: (name: string) => counters.filter((c) => c.name === name),
      metrics: {
        increment: (name: string, labels?: Record<string, string | number | undefined>) =>
          void counters.push({ name, labels: labels ?? {} }),
        observe: (
          name: string,
          value: number,
          labels?: Record<string, string | number | undefined>,
        ) => void observations.push({ name, value, labels: labels ?? {} }),
      },
    };
  }

  beforeEach(() => {
    resetBreakers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('counts a successful read and times it in seconds', async () => {
    respond(200, { sheets: [{ properties: { title: 'Tab A', index: 0 } }] });
    const rec = recorder();

    await new GoogleSheetsAdapter(API_KEY, rec.metrics).listTabs('book-1');

    expect(rec.named('places_provider_requests_total')[0]?.labels).toEqual({
      method: 'google.sheets.meta',
      status: 200,
    });
    const timing = rec.observations.find(
      (o) => o.name === 'place_provider_request_duration_seconds',
    );
    expect(timing?.labels).toEqual({ method: 'google.sheets.meta', status: 200 });
    // Seconds (#320): a stubbed fetch answers well inside one.
    expect(timing?.value).toBeGreaterThanOrEqual(0);
    expect(timing?.value).toBeLessThan(1);
  });

  it('labels the values read with its own method, not the metadata one', async () => {
    respond(200, { values: [['a']] });
    const rec = recorder();

    await new GoogleSheetsAdapter(API_KEY, rec.metrics).readTab('book-1', 'Tab A', 10);

    expect(rec.named('places_provider_requests_total')[0]?.labels).toMatchObject({
      method: 'google.sheets.values',
    });
  });

  it('counts our own misconfiguration as a provider failure', async () => {
    respond(403, SERVICE_DISABLED_BODY);
    const rec = recorder();

    await new GoogleSheetsAdapter(API_KEY, rec.metrics).listTabs('book-1').catch(() => undefined);

    expect(rec.named('places_provider_failures_total')[0]?.labels).toEqual({
      method: 'google.sheets.meta',
      status: 403,
      reason: 'SERVICE_DISABLED',
    });
    // PERMISSION_DENIED is not a client reject, and a disabled API is ours.
    expect(rec.named('places_provider_rejected_total')).toHaveLength(0);
  });

  it('counts a sheet that does not exist as rejected, not as Google failing', async () => {
    respond(404, { error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' } });
    const rec = recorder();

    await new GoogleSheetsAdapter(API_KEY, rec.metrics).listTabs('book-1').catch(() => undefined);

    // #314's distinction: the operator's link is wrong. An alert on
    // `places_provider_failures_total` says Google is not serving us, and a
    // pasted bad link must not make that statement false.
    expect(rec.named('places_provider_rejected_total')[0]?.labels).toEqual({
      method: 'google.sheets.meta',
      canonical_status: 'NOT_FOUND',
    });
    expect(rec.named('places_provider_failures_total')).toHaveLength(0);
  });

  it('bounds the reason label to a known vocabulary', async () => {
    respond(500, {
      error: {
        status: 'INTERNAL',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'SOMETHING_GOOGLE_INVENTED_LAST_TUESDAY',
          },
        ],
      },
    });
    const rec = recorder();

    await new GoogleSheetsAdapter(API_KEY, rec.metrics).listTabs('book-1').catch(() => undefined);

    // Google owns that vocabulary and can add to it; a label whose domain
    // another company controls is not bounded (#319). The raw reason still
    // rides the error and the log.
    const failures = rec.named('places_provider_failures_total');
    expect(failures.length).toBeGreaterThan(0);
    for (const f of failures) expect(f.labels.reason).toBe('other');
  });

  it('never bills Sheets — it is quota-limited, not charged per call', async () => {
    respond(200, { sheets: [] });
    const rec = recorder();

    await new GoogleSheetsAdapter(API_KEY, rec.metrics).listTabs('book-1');

    // A SKU line with no invoice behind it is a number that cannot be checked.
    expect(rec.named('places_provider_cost_units')).toHaveLength(0);
  });

  it('still works with no metrics sink at all', async () => {
    respond(200, { sheets: [{ properties: { title: 'T', index: 0 } }] });
    await expect(new GoogleSheetsAdapter(API_KEY).listTabs('book-1')).resolves.toHaveLength(1);
  });
});
