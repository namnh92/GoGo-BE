import { inflateRawSync } from 'node:zlib';
import { INGEST_LIMITS, IngestFileError } from './limits';

/**
 * PI-BE-011 — minimal, read-only ZIP reader for XLSX.
 *
 * Deliberately hand-written instead of pulling a spreadsheet library: the
 * import path takes untrusted files, and this keeps three properties explicit
 * — nothing in the archive is ever executed, only the handful of XML parts we
 * name are inflated, and expansion is capped so a zip bomb fails fast.
 */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
};

export class ZipArchive {
  private constructor(
    private readonly buf: Buffer,
    readonly entries: Map<string, ZipEntry>,
  ) {}

  static open(buf: Buffer): ZipArchive {
    const eocd = findEocd(buf);
    const totalEntries = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (cdOffset === ZIP64_MARKER || totalEntries === 0xffff) {
      throw new IngestFileError('FILE_UNSUPPORTED', 'ZIP64 archives are not supported');
    }

    const entries = new Map<string, ZipEntry>();
    let p = cdOffset;
    let declaredUncompressed = 0;
    for (let n = 0; n < totalEntries; n++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
        throw new IngestFileError('FILE_CORRUPT', 'Archive central directory is corrupt');
      }
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const uncompressedSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localHeaderOffset = buf.readUInt32LE(p + 42);
      if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
        throw new IngestFileError('FILE_UNSUPPORTED', 'ZIP64 archives are not supported');
      }
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

      declaredUncompressed += uncompressedSize;
      if (declaredUncompressed > INGEST_LIMITS.maxDecompressedBytes) {
        throw new IngestFileError('FILE_TOO_LARGE', 'Archive expands beyond the allowed size');
      }
      if (compressedSize > 0 && uncompressedSize / compressedSize > INGEST_LIMITS.maxEntryRatio) {
        throw new IngestFileError('FILE_TOO_LARGE', `Entry ${name} has a suspicious ratio`);
      }

      entries.set(name, {
        name,
        method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        encrypted: (flags & 0x1) !== 0,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new ZipArchive(buf, entries);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Names are matched exactly — nothing is resolved or globbed by the caller. */
  read(name: string): Buffer {
    const entry = this.entries.get(name);
    if (!entry) throw new IngestFileError('FILE_CORRUPT', `Missing archive entry ${name}`);
    if (entry.encrypted) {
      throw new IngestFileError('FILE_UNSUPPORTED', 'Encrypted archives are not supported');
    }

    const h = entry.localHeaderOffset;
    if (h + 30 > this.buf.length || this.buf.readUInt32LE(h) !== LOCAL_SIG) {
      throw new IngestFileError('FILE_CORRUPT', 'Archive local header is corrupt');
    }
    const nameLen = this.buf.readUInt16LE(h + 26);
    const extraLen = this.buf.readUInt16LE(h + 28);
    const start = h + 30 + nameLen + extraLen;
    const raw = this.buf.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method !== 8) {
      throw new IngestFileError('FILE_UNSUPPORTED', `Compression method ${entry.method}`);
    }
    // maxOutputLength turns a lying central directory into an error rather
    // than an unbounded allocation.
    return inflateRawSync(raw, {
      maxOutputLength: Math.min(
        INGEST_LIMITS.maxDecompressedBytes,
        Math.max(entry.uncompressedSize, 1024) * 2,
      ),
    });
  }
}

function findEocd(buf: Buffer): number {
  const maxComment = 0xffff;
  const from = Math.max(0, buf.length - (maxComment + 22));
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new IngestFileError('FILE_CORRUPT', 'Not a valid XLSX archive');
}
