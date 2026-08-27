import { INGEST_SHEET_HOSTS, parseSpreadsheetId } from './sheets-url';
import {
  ProviderQuotaExceededError,
  SheetAccessError,
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
 * turn into a 100k-row read, and maps provider status codes to the permission
 * errors the CMS wizard shows verbatim. The API key stays in this adapter and
 * is never echoed into an error, a log line, or a job record.
 */
export class GoogleSheetsAdapter implements SheetsPort {
  constructor(private readonly apiKey: string) {}

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
        const res = await fetch(url, {
          signal,
          headers: { 'X-Goog-Api-Key': this.apiKey, Accept: 'application/json' },
        });
        if (res.ok) return (await res.json()) as T;
        // Quota and permission outcomes are decisions, not transient faults —
        // rethrown as-is so the retry loop does not burn more quota.
        if (res.status === 429) throw new ProviderQuotaExceededError('google.sheets');
        if (res.status === 403) {
          throw new SheetAccessError(
            'SHEET_PERMISSION_DENIED',
            'Không có quyền đọc Google Sheet này',
          );
        }
        if (res.status === 404) {
          throw new SheetAccessError('SHEET_NOT_FOUND', 'Không tìm thấy Google Sheet');
        }
        if (res.status === 400) {
          throw new SheetAccessError('SHEET_TAB_NOT_FOUND', 'Tab không tồn tại trong sheet');
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
