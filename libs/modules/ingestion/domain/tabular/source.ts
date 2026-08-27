import { parseCsv } from './csv';
import { INGEST_LIMITS, IngestFileError } from './limits';
import type { SheetGrid } from './types';
import { parseXlsx } from './xlsx';

/**
 * PI-BE-011 §12 — content sniffing. The declared extension and the multipart
 * mimetype are both attacker-controlled, so the format is decided by the
 * leading bytes and the extension only has to agree.
 */

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

export type DetectedFormat = 'csv' | 'xlsx';

export function detectFormat(bytes: Buffer, fileName?: string): DetectedFormat {
  if (bytes.byteLength === 0) throw new IngestFileError('FILE_EMPTY', 'File is empty');
  if (bytes.byteLength > INGEST_LIMITS.maxFileBytes) {
    throw new IngestFileError('FILE_TOO_LARGE', 'File exceeds the 20 MB limit');
  }
  if (bytes.subarray(0, 4).equals(OLE2_MAGIC)) {
    throw new IngestFileError('FILE_UNSUPPORTED', 'Legacy .xls is not supported — save as .xlsx');
  }
  const isZip = bytes.subarray(0, 4).equals(ZIP_MAGIC);
  const ext = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];

  if (isZip) {
    if (ext && ext !== 'xlsx') {
      throw new IngestFileError('FILE_TYPE_MISMATCH', `Content is XLSX but the file is .${ext}`);
    }
    return 'xlsx';
  }
  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') {
    throw new IngestFileError('FILE_TYPE_MISMATCH', `Content is not a valid .${ext} workbook`);
  }
  return 'csv';
}

/**
 * The upload filename is attacker-controlled and ends up stored on the job and
 * rendered in the CMS. Keep the basename, drop control characters and path
 * separators, and cap the length.
 */
export function sanitizeFileName(raw: string | undefined): string {
  const base = (raw ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>"'`]/g, '')
    .trim();
  return base.slice(0, 180) || 'upload';
}

/** One entry point for uploads: bytes in, one grid per tab out. */
export function parseTabularSource(
  bytes: Buffer,
  fileName?: string,
): { format: DetectedFormat; grids: SheetGrid[] } {
  const format = detectFormat(bytes, fileName);
  return format === 'xlsx'
    ? { format, grids: parseXlsx(bytes) }
    : { format, grids: [parseCsv(bytes, fileName ?? 'csv')] };
}
