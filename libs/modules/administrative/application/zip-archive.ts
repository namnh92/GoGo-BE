import { inflateRawSync } from 'node:zlib';

/**
 * ADM-007 (#460) — just enough ZIP to read one pinned archive.
 *
 * The boundary release ships as a 47.6 MB zip of 3,355 GeoJSON files. Reading
 * it needs a central-directory walk and raw inflate, both of which Node already
 * provides in `zlib` — so this is ~90 lines instead of a new runtime dependency
 * in a repository whose root `package.json` has none at all. The trade is
 * deliberate: a dependency added for one offline loader is a supply-chain
 * surface for the whole API, and this format has not changed since 1993.
 *
 * Deliberately partial. Stored (0) and deflate (8) are supported; anything else
 * throws by name rather than returning wrong bytes. Zip64 is not supported and
 * says so — the pinned archive is 47.6 MB with 3,355 entries, far inside the
 * 32-bit fields, and an archive that needed Zip64 would be a different archive
 * than the one that was pinned and checksummed.
 *
 * Entries are inflated **one at a time**. The archive expands to 629 MB, so a
 * reader that decompressed eagerly would need two thirds of a gigabyte of heap
 * to answer a question about one commune.
 */

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(`unreadable zip archive: ${message}`);
    this.name = 'ZipFormatError';
  }
}

export type ZipEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** Inflates this entry and nothing else. */
  read: () => Buffer;
};

const END_OF_CENTRAL_DIRECTORY = 0x0605_4b50;
const CENTRAL_FILE_HEADER = 0x0201_4b50;
const LOCAL_FILE_HEADER = 0x0403_4b50;
const ZIP64_MARKER = 0xffff;

/** Lists the archive's entries. Nothing is decompressed until `read` is called. */
export function readZipEntries(archive: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const total = archive.readUInt16LE(eocd + 10);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  if (total === ZIP64_MARKER || directoryOffset === 0xffff_ffff) {
    throw new ZipFormatError('Zip64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let i = 0; i < total; i += 1) {
    if (archive.readUInt32LE(cursor) !== CENTRAL_FILE_HEADER) {
      throw new ZipFormatError(`central directory entry ${i} has a bad signature`);
    }
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      read: () => inflateEntry(archive, name, localOffset, method, compressedSize),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function inflateEntry(
  archive: Buffer,
  name: string,
  localOffset: number,
  method: number,
  compressedSize: number,
): Buffer {
  if (archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
    throw new ZipFormatError(`${name} has a bad local header`);
  }
  // The local header repeats the name and extra lengths, and the extra field
  // is routinely a different length from the central directory's copy — so the
  // data offset is computed from the local header, never from the directory.
  const nameLength = archive.readUInt16LE(localOffset + 26);
  const extraLength = archive.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const body = archive.subarray(start, start + compressedSize);

  if (method === 0) return Buffer.from(body);
  if (method === 8) return inflateRawSync(body);
  throw new ZipFormatError(`${name} uses compression method ${method}`);
}

/**
 * The end-of-central-directory record is at the end, after a comment of
 * unknown length, so it is found by scanning backwards for its signature.
 */
function findEndOfCentralDirectory(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= earliest; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new ZipFormatError(
    'no end-of-central-directory record; the file is not a zip or is truncated',
  );
}
