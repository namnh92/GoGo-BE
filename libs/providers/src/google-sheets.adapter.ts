import { INGEST_SHEET_HOSTS, parseSpreadsheetId } from './sheets-url';
import {
  CLIENT_REJECT_STATUSES,
  boundedReason,
  isMisconfiguredReason,
  readGoogleError,
} from './google-error';
import {
  NO_PROVIDER_METRICS,
  ProviderQuotaExceededError,
  SheetAccessError,
  type ProviderMetrics,
  type SheetTab,
  type SheetsPort,
} from './ports';
import { withResilience } from './resilience';

const RESILIENCE = {
  timeoutMs: 8000,
  retries: 1,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
};

/**
 * PI-BE-012 — Google Sheets v4 reader.
 *
 * Uses the values API with an explicit A1 range so a 100k-row sheet cannot
 * turn into a 100k-row read, and maps provider failures to the errors the CMS
 * wizard shows verbatim — by reason code where Google gives one, by status only
 * where it does not (PI-BE-022). The API key stays in this adapter and is never
 * echoed into an error, a log line, or a job record.
 *
 * #321 — instrumented like the other two. It was the only Google adapter
 * emitting nothing, so the CMS row for Sheets could show no calls, no failure
 * rate and no latency, and a dashboard rendering that as zero would read as
 * "nobody used it" rather than "nobody measured it".
 *
 * No cost counter, deliberately. `places_provider_cost_units` exists to be
 * reconciled against an invoice; the Sheets API is quota-limited and not
 * billed per call, so a SKU line for it would be a number with nothing behind
 * it.
 */
export class GoogleSheetsAdapter implements SheetsPort {
  constructor(
    private readonly apiKey: string,
    private readonly metrics: ProviderMetrics = NO_PROVIDER_METRICS,
  ) {}

  async listTabs(spreadsheetId: string): Promise<SheetTab[]> {
    const data = await this.call<{
      sheets?: { properties?: { title?: string; index?: number } }[];
    }>(
      'google.sheets.meta',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId,
      )}?fields=sheets.properties.title,sheets.properties.index`,
    );
    return (data.sheets ?? [])
      .map((s, i) => ({
        title: s.properties?.title ?? `Sheet${i + 1}`,
        index: s.properties?.index ?? i,
      }))
      .sort((a, b) => a.index - b.index);
  }

  async readTab(spreadsheetId: string, title: string, maxRows: number): Promise<string[][]> {
    // +1 for the header row; the range is the bound, not a post-filter.
    const range = `${quoteA1(title)}!A1:BZ${Math.max(2, maxRows + 1)}`;
    const data = await this.call<{ values?: string[][] }>(
      'google.sheets.values',
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId,
      )}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
    );
    return (data.values ?? []).map((row) => row.map((cell) => String(cell ?? '')));
  }

  private async call<T>(name: string, url: string): Promise<T> {
    try {
      return await withResilience({ name, ...RESILIENCE }, async (signal) => {
        const started = Date.now();
        const res = await fetch(url, {
          signal,
          headers: { 'X-Goog-Api-Key': this.apiKey, Accept: 'application/json' },
        });
        this.metrics.increment('places_provider_requests_total', {
          method: name,
          status: res.status,
        });
        this.metrics.observe(
          'place_provider_request_duration_seconds',
          (Date.now() - started) / 1000,
          { method: name, status: res.status },
        );
        if (res.ok) return (await res.json()) as T;

        const { reason, canonicalStatus } = await readGoogleError(res);

        // #314's distinction, applied here: a sheet nobody shared with us or a
        // tab that does not exist is the operator's link being wrong, not
        // Google failing to serve us. Counted apart so an alert on
        // `places_provider_failures_total` keeps meaning what it says.
        //
        // Misconfiguration wins, exactly as in `googleFailure`: a 404 whose
        // body says the API was never enabled is our console, not their link.
        // This classifies the metric only — every error thrown below is
        // unchanged, because the CMS wizard renders those codes verbatim.
        if (
          canonicalStatus &&
          CLIENT_REJECT_STATUSES.has(canonicalStatus) &&
          !isMisconfiguredReason(reason)
        ) {
          this.metrics.increment('places_provider_rejected_total', {
            method: name,
            canonical_status: canonicalStatus,
          });
        } else {
          this.metrics.increment('places_provider_failures_total', {
            method: name,
            status: res.status,
            reason: boundedReason(reason),
          });
        }

        // PI-BE-022: the status alone does not say whose fault it is. Google
        // answers 403 PERMISSION_DENIED both for a sheet nobody shared with us
        // and for an API we never enabled on our own project, and the second
        // was reaching editors as "Không có quyền đọc Google Sheet này" — a
        // sentence about their document, describing our console. The reason
        // code is the only thing that separates them, so it is read before the
        // status is looked at.
        if (isMisconfiguredReason(reason)) {
          throw new SheetAccessError(
            'SHEET_PROVIDER_NOT_CONFIGURED',
            'GoGo chưa cấu hình kết nối Google Sheets',
            reason,
          );
        }
        // Quota and permission outcomes are decisions, not transient faults —
        // rethrown as-is so the retry loop does not burn more quota.
        if (res.status === 429) throw new ProviderQuotaExceededError('google.sheets');
        if (res.status === 403) {
          throw new SheetAccessError(
            'SHEET_PERMISSION_DENIED',
            'Không có quyền đọc Google Sheet này',
            reason,
          );
        }
        if (res.status === 404) {
          throw new SheetAccessError('SHEET_NOT_FOUND', 'Không tìm thấy Google Sheet', reason);
        }
        if (res.status === 400) {
          throw new SheetAccessError(
            'SHEET_TAB_NOT_FOUND',
            'Tab không tồn tại trong sheet',
            reason,
          );
        }
        throw new Error(`sheets ${res.status}`);
      });
    } catch (err) {
      if (err instanceof SheetAccessError || err instanceof ProviderQuotaExceededError) throw err;
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof SheetAccessError || cause instanceof ProviderQuotaExceededError) {
        throw cause;
      }
      throw new SheetAccessError('SHEET_UNAVAILABLE', 'Google Sheets tạm thời không phản hồi');
    }
  }
}

/** Sheet titles can contain spaces and quotes; A1 notation needs them quoted. */
function quoteA1(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export { INGEST_SHEET_HOSTS, parseSpreadsheetId };
