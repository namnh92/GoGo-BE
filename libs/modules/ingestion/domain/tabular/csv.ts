import { INGEST_LIMITS, IngestFileError } from './limits';
import type { SheetGrid } from './types';

/**
 * PI-BE-011 — RFC 4180 CSV reader. Hand-written on purpose: the parser is the
 * trust boundary for hostile uploads, so it enforces the row/column/cell caps
 * while scanning instead of parsing first and checking later.
 */

const DELIMITERS = [',', ';', '\t'] as const;

/** Picks the delimiter that yields the most columns on the header line. */
function sniffDelimiter(headerLine: string): string {
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    // Count only delimiters outside quotes — "a,b";c must score 1 for ';'.
    let count = 0;
    let quoted = false;
    for (let i = 0; i < headerLine.length; i++) {
      const ch = headerLine[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

function decodeUtf8(bytes: Buffer): string {
  // Reject invalid UTF-8 rather than silently producing U+FFFD soup: an
  // editor saving CP1258/Latin-1 must be told, not given mangled Vietnamese.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (text.includes('�')) {
    throw new IngestFileError('FILE_ENCODING_INVALID', 'File must be UTF-8 encoded');
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseCsv(bytes: Buffer, sheetName = 'csv'): SheetGrid {
  if (bytes.byteLength > INGEST_LIMITS.maxFileBytes) {
    throw new IngestFileError('FILE_TOO_LARGE', 'File exceeds the 20 MB limit');
  }
  const text = decodeUtf8(bytes);

  const firstBreak = text.search(/\r?\n/);
  const delimiter = sniffDelimiter(firstBreak === -1 ? text : text.slice(0, firstBreak));

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const pushField = (): void => {
    if (field.length > INGEST_LIMITS.maxCellChars) {
      throw new IngestFileError(
        'CELL_TOO_LONG',
        `Cell exceeds ${INGEST_LIMITS.maxCellChars} chars`,
      );
    }
    row.push(field);
    field = '';
    if (row.length > INGEST_LIMITS.maxColumns) {
      throw new IngestFileError(
        'TOO_MANY_COLUMNS',
        `More than ${INGEST_LIMITS.maxColumns} columns`,
      );
    }
  };
  const pushRow = (): void => {
    pushField();
    // Trailing blank lines are not rows.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    // +1 for the header line.
    if (rows.length > INGEST_LIMITS.maxRows + 1) {
      throw new IngestFileError('TOO_MANY_ROWS', `More than ${INGEST_LIMITS.maxRows} rows`);
    }
  };

  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      pushRow();
      i += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) pushRow();

  const [header = [], ...data] = rows;
  return { name: sheetName, headers: header.map((h) => h.trim()), rows: data };
}
