import type { IngestMessage } from '@gogo/database';

/**
 * PI-BE-017 — downloadable error report (spec §9.2, §12).
 *
 * The report is opened in Excel/Sheets by the people who uploaded the file, so
 * every cell is neutralised against formula injection before it is written.
 */

const REPORT_HEADERS = [
  'row_number',
  'source_row_id',
  'status',
  'error_codes',
  'error_messages',
  'warning_codes',
  'warning_messages',
] as const;

/**
 * A leading `=`, `+`, `-`, `@`, tab or CR makes a spreadsheet evaluate the
 * cell. Prefixing an apostrophe keeps the text visible while forcing the
 * cell to be literal.
 */
export function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const neutralised = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${neutralised.replace(/"/g, '""')}"`;
}

export type ErrorReportRow = {
  rowNumber: number;
  sourceRowId: string;
  status: string;
  errors: IngestMessage[];
  warnings: IngestMessage[];
};

export function buildErrorReportCsv(rows: ErrorReportRow[]): string {
  const lines = [REPORT_HEADERS.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.rowNumber,
        row.sourceRowId,
        row.status,
        row.errors.map((e) => e.code).join('|'),
        row.errors.map((e) => `${e.field ?? '-'}: ${e.message}`).join(' | '),
        row.warnings.map((w) => w.code).join('|'),
        row.warnings.map((w) => `${w.field ?? '-'}: ${w.message}`).join(' | '),
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  // BOM so Excel opens the Vietnamese text as UTF-8 without an import wizard.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
