import { SheetAccessError } from './ports';

/** Only Google's own spreadsheet host is accepted — no redirect following. */
export const INGEST_SHEET_HOSTS = new Set(['docs.google.com']);

/**
 * PI-BE-012 §12 — extract the spreadsheet id from a share URL without ever
 * fetching the URL itself. A bare id is accepted so the CMS can paste either.
 */
export function parseSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{20,120}$/.test(trimmed)) return trimmed;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SheetAccessError('SHEET_URL_INVALID', 'Google Sheets URL không hợp lệ');
  }
  if (url.protocol !== 'https:' || !INGEST_SHEET_HOSTS.has(url.hostname.toLowerCase())) {
    throw new SheetAccessError('SHEET_URL_INVALID', 'Chỉ chấp nhận link docs.google.com');
  }
  const match = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,120})/.exec(url.pathname);
  if (!match) throw new SheetAccessError('SHEET_URL_INVALID', 'Không tìm thấy spreadsheet id');
  return match[1]!;
}
