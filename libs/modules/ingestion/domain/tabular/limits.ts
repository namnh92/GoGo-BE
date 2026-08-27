/**
 * PI-BE-011 — hard bounds for every uploaded source (spec §4.1, §12).
 * Applied before any parsing work so a hostile file cannot make the parser
 * allocate its way out of the limits it is supposed to enforce.
 */
export const INGEST_LIMITS = {
  /** 20 MB per file. */
  maxFileBytes: 20 * 1024 * 1024,
  /** 5.000 data rows per job (header excluded). */
  maxRows: 5000,
  maxColumns: 64,
  maxCellChars: 2000,
  /**
   * Zip-bomb guards for XLSX: a 20 MB archive that expands past this, or any
   * single entry expanding more than `maxEntryRatio`×, is rejected unparsed.
   */
  maxDecompressedBytes: 200 * 1024 * 1024,
  maxEntryRatio: 200,
  /** Rows processed per background chunk (spec §9.4). */
  chunkSize: 50,
} as const;

export class IngestFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IngestFileError';
  }
}
