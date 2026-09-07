import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { readZipEntries, ZipFormatError } from './zip-archive';

/**
 * ADM-007 (#460) — the minimal ZIP reader, against the committed fixture.
 *
 * The fixture is a real archive produced by a real zip implementation, which is
 * the point: a hand-rolled reader tested only against hand-rolled archives
 * proves that two of my own assumptions agree with each other.
 */

const FIXTURE = path.resolve(
  __dirname,
  '../../../../resources/administrative/boundaries-fixture.v5.0.0.zip',
);

describe('reading a real archive', () => {
  const archive = readFileSync(FIXTURE);

  it('lists every entry from the central directory', () => {
    const entries = readZipEntries(archive);
    expect(entries.map((e) => e.name).sort()).toEqual([
      'geojson/01_ha_noi/01_ha_noi.geojson',
      'geojson/01_ha_noi/wards/00004_ba_dinh.geojson',
      'geojson/01_ha_noi/wards/00008_ngoc_ha.geojson',
      'geojson/48_da_nang/48_da_nang.geojson',
      'geojson/48_da_nang/wards/20333_hoang_sa.geojson',
    ]);
  });

  it('inflates an entry to exactly the size the directory declares', () => {
    const entry = readZipEntries(archive).find((e) => e.name.endsWith('00004_ba_dinh.geojson'))!;
    const bytes = entry.read();
    expect(bytes.length).toBe(entry.uncompressedSize);
    const parsed = JSON.parse(bytes.toString('utf8')) as {
      features: { properties: { code: string }; geometry: { type: string } }[];
    };
    expect(parsed.features[0]!.properties.code).toBe('00004');
    expect(parsed.features[0]!.geometry.type).toBe('MultiPolygon');
  });

  it('does not decompress anything until an entry is read', () => {
    // The release expands to 629 MB; a reader that inflated eagerly would need
    // two thirds of a gigabyte to answer a question about one commune.
    const entries = readZipEntries(archive);
    expect(entries.every((e) => e.uncompressedSize > e.compressedSize)).toBe(true);
    expect(typeof entries[0]!.read).toBe('function');
  });
});

describe('refusing what it cannot read', () => {
  it('rejects a file with no end-of-central-directory record', () => {
    expect(() => readZipEntries(Buffer.alloc(64))).toThrow(ZipFormatError);
  });

  it('rejects a truncated archive rather than returning partial entries', () => {
    const archive = readFileSync(FIXTURE);
    expect(() => readZipEntries(archive.subarray(0, archive.length - 40))).toThrow(ZipFormatError);
  });

  it('names an unsupported compression method instead of returning wrong bytes', () => {
    // Method 9 (deflate64) is real and not supported. Silently inflating it as
    // deflate would produce plausible-looking garbage.
    const body = deflateRawSync(Buffer.from('{}'));
    const name = Buffer.from('x.geojson');
    const local = Buffer.alloc(30 + name.length + body.length);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(9, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(2, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    body.copy(local, 30 + name.length);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(9, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(2, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    name.copy(central, 46);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x0605_4b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(local.length, 16);

    const archive = Buffer.concat([local, central, end]);
    const entry = readZipEntries(archive)[0]!;
    expect(() => entry.read()).toThrow(/compression method 9/);
  });
});
