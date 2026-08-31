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
