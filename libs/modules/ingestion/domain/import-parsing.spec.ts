import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_FIELDS,
  InvalidColumnMappingError,
  LEGACY_FIELD_ALIASES,
  RETIRED_FIELDS,
  applyMapping,
  parseColumnMapping,
  resolveMapping,
  unusableHeaders,
} from './column-mapping';
import { buildErrorReportCsv, escapeCsvCell } from './error-report';
import { validateRow } from './template';
import {
  INGEST_LIMITS,
  IngestFileError,
  detectFormat,
  parseCsv,
  parseXlsx,
  sanitizeFileName,
} from './tabular';

/**
 * PI-BE-011/013/017 — parser, mapping, validation and export.
 * The parsers are the trust boundary for hostile uploads, so the hostile
 * cases (bomb, macro, type mismatch, formula injection) are the point.
 */

/** Asserts the failure by its stable code, not by its Vietnamese message. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(IngestFileError);
    expect((err as IngestFileError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
}

// --- minimal XLSX builder (stored entries, no compression) ------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

type ZipInput = { name: string; data: Buffer; deflate?: boolean; fakeUncompressed?: number };

function buildZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const stored = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const uncompressed = entry.fakeUncompressed ?? entry.data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, stored);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + stored.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function sheetXml(rows: string[][]): string {
  const cells = rows
    .map(
      (row, r) =>
        `<row r="${r + 1}">${row
          .map(
            (value, c) =>
              `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${value}</t></is></c>`,
          )
          .join('')}</row>`,
    )
    .join('');
  return `<?xml version="1.0"?><worksheet><sheetData>${cells}</sheetData></worksheet>`;
}

function makeXlsx(sheets: { name: string; rows: string[][] }[], extra: ZipInput[] = []): Buffer {
  const entries: ZipInput[] = [
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0"?><workbook><sheets>${sheets
          .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('')}</sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<?xml version="1.0"?><Relationships>${sheets
          .map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join('')}</Relationships>`,
      ),
    },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(s.rows), 'utf8'),
    })),
  ];
  return buildZip([...entries, ...extra]);
}

// --- CSV --------------------------------------------------------------------

describe('parseCsv', () => {
  it('reads quoted fields, embedded newlines and CRLF', () => {
    const csv = Buffer.from(
      'source_row_id,name,note\r\nHCM-1,"FIGHT ""STATION""","line1\nline2"\r\nHCM-2,Cafe,\r\n',
      'utf8',
    );
    const grid = parseCsv(csv);
    expect(grid.headers).toEqual(['source_row_id', 'name', 'note']);
    expect(grid.rows).toHaveLength(2);
    expect(grid.rows[0]).toEqual(['HCM-1', 'FIGHT "STATION"', 'line1\nline2']);
  });

  it('strips the BOM and keeps Vietnamese diacritics', () => {
    const grid = parseCsv(Buffer.from('\uFEFFname,city\nQuán Ăn,Hồ Chí Minh\n', 'utf8'));
    expect(grid.headers).toEqual(['name', 'city']);
    expect(grid.rows[0]).toEqual(['Quán Ăn', 'Hồ Chí Minh']);
  });

  it('sniffs semicolon-delimited exports', () => {
    const grid = parseCsv(Buffer.from('name;city;category\nA;HCM;cafe\n', 'utf8'));
    expect(grid.headers).toEqual(['name', 'city', 'category']);
    expect(grid.rows[0]).toEqual(['A', 'HCM', 'cafe']);
  });

  it('rejects non-UTF-8 content instead of mangling it', () => {
    // "Quán" in CP1258 — invalid as UTF-8.
    expect(() => parseCsv(Buffer.from([0x51, 0x75, 0xe1, 0x6e]))).toThrow(IngestFileError);
  });

  it('refuses more than the row cap', () => {
    const rows = [
      'id,name',
      ...Array.from({ length: INGEST_LIMITS.maxRows + 5 }, (_, i) => `${i},x`),
    ];
    expectCode(() => parseCsv(Buffer.from(rows.join('\n'), 'utf8')), 'TOO_MANY_ROWS');
  });
});

// --- XLSX -------------------------------------------------------------------

describe('parseXlsx', () => {
  it('reads every tab in workbook order', () => {
    const bytes = makeXlsx([
      {
        name: 'HCM',
        rows: [
          ['name', 'city'],
          ['Quán A', 'Hồ Chí Minh'],
        ],
      },
      {
        name: 'HN',
        rows: [
          ['name', 'city'],
          ['Quán B', 'Hà Nội'],
        ],
      },
    ]);
    const grids = parseXlsx(bytes);
    expect(grids.map((g) => g.name)).toEqual(['HCM', 'HN']);
    expect(grids[1]!.rows[0]).toEqual(['Quán B', 'Hà Nội']);
  });

  it('rejects macro-enabled workbooks', () => {
    const bytes = makeXlsx(
      [{ name: 'S1', rows: [['name'], ['A']] }],
      [{ name: 'xl/vbaProject.bin', data: Buffer.from('MZ') }],
    );
    expectCode(() => parseXlsx(bytes), 'FILE_MACRO_NOT_ALLOWED');
  });

  it('rejects an entry whose declared expansion is a bomb', () => {
    const payload = Buffer.alloc(1024, 0x41);
    const bytes = makeXlsx(
      [{ name: 'S1', rows: [['name'], ['A']] }],
      [
        // Declares a 1 GB expansion from a ~1 KB entry.
        { name: 'xl/bomb.bin', data: payload, deflate: true, fakeUncompressed: 1024 * 1024 * 1024 },
      ],
    );
    expectCode(() => parseXlsx(bytes), 'FILE_TOO_LARGE');
  });
});

describe('detectFormat', () => {
  it('decides on content, not on the extension', () => {
    const xlsx = makeXlsx([{ name: 'S1', rows: [['name'], ['A']] }]);
    expect(detectFormat(xlsx, 'places.xlsx')).toBe('xlsx');
    // A .xlsx name over CSV bytes is a mismatch, not a silent CSV parse.
    expectCode(() => detectFormat(Buffer.from('a,b\n1,2'), 'places.xlsx'), 'FILE_TYPE_MISMATCH');
    expect(detectFormat(Buffer.from('a,b\n1,2'), 'places.csv')).toBe('csv');
  });

  it('rejects legacy .xls', () => {
    expectCode(
      () => detectFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00]), 'old.xls'),
      'FILE_UNSUPPORTED',
    );
  });
});

// --- mapping + validation ---------------------------------------------------

describe('resolveMapping', () => {
  it('maps the legacy GOGO sheet headers without configuration', () => {
    const { mapping } = resolveMapping([
      'Tên địa điểm',
      'Loại hình',
      'Khu vực (Quận/Huyện)',
      'Khoảng giá/người',
      'Đi cùng ai?',
      'Vibe/Bầu không khí',
      'Link Google Maps',
    ]);
    expect(mapping['Tên địa điểm']).toBe('name');
    expect(mapping['Loại hình']).toBe('category_raw');
    expect(mapping['Khoảng giá/người']).toBe('price_raw');
    expect(mapping['Đi cùng ai?']).toBe('audiences_raw');
    expect(mapping['Link Google Maps']).toBe('google_maps_url');
  });

  it('lets an explicit wizard mapping win and reports unmapped headers', () => {
    const { mapping, unmapped } = resolveMapping(['Tên địa điểm', 'Cột lạ'], {
      'Tên địa điểm': 'highlight',
    });
    expect(mapping['Tên địa điểm']).toBe('highlight');
    expect(unmapped).toEqual(['Cột lạ']);
  });

  it('applies the mapping positionally', () => {
    const headers = ['source_row_id', 'name'];
    const { mapping } = resolveMapping(headers);
    expect(applyMapping(headers, ['HCM-1', 'Quán A'], mapping)).toEqual({
      source_row_id: 'HCM-1',
      name: 'Quán A',
    });
  });
});

describe('validateRow', () => {
  const categories = new Set(['cafe', 'restaurant']);

  it('accepts a complete template row', () => {
    const { normalized, errors } = validateRow(
      {
        source_row_id: 'HCM-0001',
        name: 'FIGHT STATION',
        city: 'Hồ Chí Minh',
        district: 'Bình Thạnh',
        google_maps_url: 'https://maps.app.goo.gl/example',
        category: 'cafe',
        price_min: '100000',
        price_max: '250000',
        price_unit: 'per_person',
      },
      { knownCategoryKeys: categories },
    );
    expect(errors).toEqual([]);
    expect(normalized.priceMin).toBe(100_000);
    expect(normalized.categoryKey).toBe('cafe');
  });

  it('rejects an unknown taxonomy key instead of creating one', () => {
    const { errors, normalized } = validateRow(
      { source_row_id: '1', name: 'A', city: 'HCM', category: 'indoor_activity' },
      { knownCategoryKeys: categories },
    );
    expect(errors.map((e) => e.code)).toContain('CATEGORY_UNKNOWN');
    expect(normalized.categoryKey).toBeNull();
  });

  it('flags an inverted price range and a bad unit', () => {
    const { errors } = validateRow({
      source_row_id: '1',
      name: 'A',
      city: 'HCM',
      category: 'cafe',
      price_min: '200000',
      price_max: '100000',
      price_unit: 'per_table',
    });
    expect(errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(['PRICE_RANGE_INVALID', 'PRICE_UNIT_INVALID']),
    );
  });

  it('rejects a non-maps URL', () => {
    const { errors } = validateRow({
      source_row_id: '1',
      name: 'A',
      city: 'HCM',
      category: 'cafe',
      google_maps_url: 'https://evil.example.com/maps/place/x',
    });
    expect(errors.map((e) => e.code)).toContain('URL_INVALID');
  });

  it('parses the legacy free-text columns into structured facts', () => {
    const { normalized, warnings } = validateRow(
      {
        source_row_id: 'HN-9',
        name: 'Quán Nướng',
        city: 'Hà Nội',
        category_raw: 'Quán nướng ngoài trời',
        price_raw: '45 - 75k',
        audiences_raw: 'Cặp đôi|Bạn bè',
        vibes_raw: 'Yên tĩnh, ấm cúng',
        google_maps_url: 'Quán Nướng Ngõ 12',
      },
      { knownCategoryKeys: categories },
    );
    expect(normalized.priceMin).toBe(45_000);
    expect(normalized.priceMax).toBe(75_000);
    expect(normalized.audiences).toEqual(['couple', 'group']);
    expect(normalized.vibes).toEqual(['quiet', 'cozy']);
    // A plain name in the link column becomes a search query, not a URL error.
    expect(normalized.googleMapsUrl).toBeNull();
    expect(normalized.googleMapsQuery).toBe('Quán Nướng Ngõ 12');
    expect(warnings.map((w) => w.code)).toContain('CATEGORY_UNMAPPED');
  });

  it('requires a city, falling back to the job default', () => {
    expect(
      validateRow({ source_row_id: '1', name: 'A', category: 'cafe' }).errors.map((e) => e.code),
    ).toContain('CITY_REQUIRED');
    expect(
      validateRow({ source_row_id: '1', name: 'A', category: 'cafe' }, { defaultCity: 'HCM' })
        .normalized.city,
    ).toBe('HCM');
  });
});

// --- #274 row identity ------------------------------------------------------

describe('source_row_id fallback', () => {
  const row = { name: 'Lacàph', city: 'Ho Chi Minh City', category: 'cafe' };

  it('derives the id from row position instead of failing the row', () => {
    const { normalized, errors, warnings } = validateRow(row, { fallbackRowId: 'HCM#1' });

    expect(errors).toEqual([]);
    expect(normalized.sourceRowId).toBe('HCM#1');
    expect(warnings.map((w) => w.code)).toContain('ROW_ID_DERIVED');
  });

  it('says in the warning that a derived id moves when rows move', () => {
    const { warnings } = validateRow(row, { fallbackRowId: 'HCM#1' });
    const derived = warnings.find((w) => w.code === 'ROW_ID_DERIVED');

    // The whole risk of a positional id is invisible unless it is spelled out
    // on the row itself — an editor re-syncing this sheet needs to read it.
    expect(derived?.field).toBe('source_row_id');
    expect(derived?.message).toContain('HCM#1');
    expect(derived?.message).toMatch(/thứ tự dòng/);
  });

  it('still fails the row when no fallback is offered', () => {
    // The API/mobile path has no row position to fall back on, so the
    // requirement stands there.
    const { errors, warnings } = validateRow(row);

    expect(errors.map((e) => e.code)).toContain('ROW_ID_MISSING');
    expect(warnings.map((w) => w.code)).not.toContain('ROW_ID_DERIVED');
  });

  it('prefers the sheet’s own id over the fallback, and warns about neither', () => {
    const { normalized, errors, warnings } = validateRow(
      { ...row, source_row_id: 'HCM-0001' },
      { fallbackRowId: 'HCM#1' },
    );

    expect(errors).toEqual([]);
    expect(normalized.sourceRowId).toBe('HCM-0001');
    expect(warnings.map((w) => w.code)).not.toContain('ROW_ID_DERIVED');
  });

  it('rejects an over-long authored id rather than truncating it', () => {
    // Truncating would let two authored rows collapse onto one identity, which
    // `(job_id, source_row_id)` would then read as a retry of the same row.
    const { errors } = validateRow(
      { ...row, source_row_id: 'x'.repeat(101) },
      { fallbackRowId: 'HCM#1' },
    );

    expect(errors.map((e) => e.code)).toContain('ROW_ID_TOO_LONG');
  });

  it('treats a blank fallback as no fallback', () => {
    expect(validateRow(row, { fallbackRowId: '   ' }).errors.map((e) => e.code)).toContain(
      'ROW_ID_MISSING',
    );
  });
});

// --- #276 canonical mapping vocabulary --------------------------------------

describe('parseColumnMapping', () => {
  it('accepts every field the parser actually understands', () => {
    const mapping = Object.fromEntries(CANONICAL_FIELDS.map((f) => [`col ${f}`, f]));
    expect(parseColumnMapping(mapping).mapping).toEqual(mapping);
  });

  it('accepts an unknown value and records it instead of rejecting', () => {
    // `/v1` answered 200 for any string here, so it still does. Strict
    // rejection is a `/v2` change.
    const result = parseColumnMapping({ Link: 'gmapsLink', 'Giá từ': 'costFrom' });

    expect(result.mapping).toEqual({});
    // Both offenders recorded, not just the first.
    expect(result.unknown).toEqual([
      { header: 'Link', value: 'gmapsLink' },
      { header: 'Giá từ', value: 'costFrom' },
    ]);
  });

  it('still refuses a mapping that is not an object at all', () => {
    // This was a 400 in `/v1` too — from the schema layer, not the vocabulary.
    expect(() => parseColumnMapping('name')).toThrow(InvalidColumnMappingError);
    expect(() => parseColumnMapping([['a', 'name']])).toThrow(InvalidColumnMappingError);
  });

  it('treats an empty value as “ignore this column”, not as an error', () => {
    expect(parseColumnMapping({ Thừa: '', Tên: 'name' }).mapping).toEqual({ Tên: 'name' });
  });

  it('returns an empty mapping for a missing one', () => {
    expect(parseColumnMapping(undefined).mapping).toEqual({});
    expect(parseColumnMapping(null).mapping).toEqual({});
  });
});

// #276 — `/v1` compatibility. The shipped CMS emitted exactly eleven mapping
// values across every commit that ever contained them; these are the six that
// are not already canonical.
describe('/v1 legacy mapping compatibility', () => {
  it('normalises the three legacy spellings the CMS shipped', () => {
    const result = parseColumnMapping({
      Link: 'googleMapsUrl',
      'Giá từ': 'priceMin',
      'Giá đến': 'priceMax',
    });

    expect(result.mapping).toEqual({
      Link: 'google_maps_url',
      'Giá từ': 'price_min',
      'Giá đến': 'price_max',
    });
    expect(result.normalizedLegacy).toEqual([
      { header: 'Link', from: 'googleMapsUrl', to: 'google_maps_url' },
      { header: 'Giá từ', from: 'priceMin', to: 'price_min' },
      { header: 'Giá đến', from: 'priceMax', to: 'price_max' },
    ]);
  });

  it('covers every legacy alias declared, so the table cannot rot', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_FIELD_ALIASES)) {
      expect(parseColumnMapping({ Cột: legacy }).mapping).toEqual({ Cột: canonical });
    }
  });

  it('makes a normalised alias behave exactly like the canonical field', () => {
    const viaLegacy = resolveMapping(
      ['Link'],
      parseColumnMapping({ Link: 'googleMapsUrl' }).mapping,
    );
    const viaCanonical = resolveMapping(
      ['Link'],
      parseColumnMapping({ Link: 'google_maps_url' }).mapping,
    );
    expect(viaLegacy).toEqual(viaCanonical);
  });

  it('keeps accepting the three retired fields, mapping them nowhere', () => {
    // `/v1` answered 200 and ignored them. Turning that into a 400 would be a
    // behavioural break for the sake of tidiness.
    const result = parseColumnMapping({ 'Địa chỉ': 'address', SĐT: 'phone', Web: 'website' });

    expect(result.mapping).toEqual({});
    expect(result.retired).toEqual([
      { header: 'Địa chỉ', value: 'address' },
      { header: 'SĐT', value: 'phone' },
      { header: 'Web', value: 'website' },
    ]);
  });

  it('covers every retired field declared', () => {
    for (const field of RETIRED_FIELDS) {
      const result = parseColumnMapping({ Cột: field });
      expect(result.mapping).toEqual({});
      expect(result.retired).toEqual([{ header: 'Cột', value: field }]);
    }
  });

  it('leaves a column unmapped rather than auto-detecting after an unknown value', () => {
    // `Tên địa điểm` auto-detects to `name`. The operator named this column,
    // so quietly detecting something else would hide the mistake again.
    const parsed = parseColumnMapping({ 'Tên địa điểm': 'placeName' });
    const { mapping, unmapped } = resolveMapping(
      ['Tên địa điểm'],
      parsed.mapping,
      unusableHeaders(parsed),
    );

    expect(mapping['Tên địa điểm']).toBeUndefined();
    expect(unmapped).toEqual(['Tên địa điểm']);
  });

  it('still auto-detects a column the mapping never mentioned', () => {
    const parsed = parseColumnMapping({ 'Tên địa điểm': 'placeName' });
    const { mapping } = resolveMapping(
      ['Tên địa điểm', 'city'],
      parsed.mapping,
      unusableHeaders(parsed),
    );

    expect(mapping['city']).toBe('city');
  });

  it('accepts the full vocabulary the shipped CMS could emit', () => {
    // Every value `MAPPABLE_FIELDS` + `HEADER_HINTS` ever produced, together.
    expect(() =>
      parseColumnMapping({
        a: 'name',
        b: 'address',
        c: 'city',
        d: 'district',
        e: 'googleMapsUrl',
        f: 'category',
        g: 'priceMin',
        h: 'priceMax',
        i: 'phone',
        j: 'website',
        k: 'note',
      }),
    ).not.toThrow();
  });
});

describe('explicit mapping vs auto-detection', () => {
  it('lets an explicit choice beat what auto-detection would have picked', () => {
    // `Tên địa điểm` auto-detects to `name`; the operator says `highlight`.
    const { mapping } = resolveMapping(
      ['Tên địa điểm'],
      parseColumnMapping({ 'Tên địa điểm': 'highlight' }).mapping,
    );
    expect(mapping['Tên địa điểm']).toBe('highlight');
  });

  it('auto-detects only the columns the caller said nothing about', () => {
    const { mapping } = resolveMapping(
      ['Tên địa điểm', 'city'],
      parseColumnMapping({ 'Tên địa điểm': 'highlight' }).mapping,
    );
    expect(mapping['Tên địa điểm']).toBe('highlight');
    expect(mapping['city']).toBe('city');
  });

  it('auto-detects everything when no mapping is supplied', () => {
    const { mapping } = resolveMapping(['Tên địa điểm', 'city']);
    expect(mapping['Tên địa điểm']).toBe('name');
    expect(mapping['city']).toBe('city');
  });
});

describe('OpenAPI ImportCanonicalField', () => {
  it('carries exactly the runtime canonical fields, in order', () => {
    // The YAML is handwritten, so this is what stops it drifting from the
    // parser. Publishing a vocabulary the parser does not implement is how the
    // CMS ended up with three fields nothing could accept.
    const spec = parseYaml(
      readFileSync(path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml'), 'utf8'),
    ) as { components: { schemas: Record<string, { enum?: string[] }> } };

    expect(spec.components.schemas.ImportCanonicalField?.enum).toEqual([...CANONICAL_FIELDS]);
  });
});

describe('missing required columns', () => {
  it('names the required fields the HCM sheet has no header for', () => {
    // The real sheet from the failing import, verbatim.
    const { mapping, unmapped, missing } = resolveMapping([
      'name',
      'category',
      'district',
      'google_maps_url',
      'tags',
      'source',
      'import_status',
      'notes',
      'city',
    ]);

    expect(missing).toEqual(['source_row_id']);
    // `notes` is not an alias of `note`, so its text is dropped — the editor
    // only finds out because it is reported here.
    expect(unmapped).toEqual(['tags', 'source', 'import_status', 'notes']);
    expect(mapping['google_maps_url']).toBe('google_maps_url');
    expect(mapping['city']).toBe('city');
  });
});

// --- error report -----------------------------------------------------------

describe('error report CSV', () => {
  it('neutralises formula injection in every cell', () => {
    expect(escapeCsvCell('=cmd|/c calc')).toBe(`"'=cmd|/c calc"`);
    expect(escapeCsvCell('+1+1')).toBe(`"'+1+1"`);
    expect(escapeCsvCell('-2')).toBe(`"'-2"`);
    expect(escapeCsvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(escapeCsvCell('normal')).toBe('"normal"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('maps each row to its codes and messages', () => {
    const csv = buildErrorReportCsv([
      {
        rowNumber: 7,
        sourceRowId: '=HCM-7',
        status: 'validation_failed',
        errors: [{ code: 'CITY_REQUIRED', field: 'city', message: 'city là bắt buộc' }],
        warnings: [{ code: 'PRICE_UNPARSED', field: 'price_raw', message: 'Không đọc được giá' }],
      },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toContain('row_number');
    expect(lines[1]).toContain('"7"');
    expect(lines[1]).toContain(`"'=HCM-7"`);
    expect(lines[1]).toContain('CITY_REQUIRED');
    expect(lines[1]).toContain('PRICE_UNPARSED');
  });
});

// --- PI-SEC-001 regressions -------------------------------------------------

describe('hostile input hardening', () => {
  it('leaves an out-of-range XML entity as text instead of throwing', () => {
    const bytes = makeXlsx([{ name: 'S1', rows: [['name'], ['ok']] }]);
    // Rebuild sheet1 with a code point above the Unicode maximum.
    const hostile = makeXlsx([{ name: 'S1', rows: [['name'], ['A&#x110000;B']] }]);
    expect(() => parseXlsx(bytes)).not.toThrow();
    const grids = parseXlsx(hostile);
    expect(grids[0]!.rows[0]![0]).toBe('A&#x110000;B');
  });

  it('sanitises a hostile upload filename', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a\\b\\c.csv')).toBe('c.csv');
    expect(sanitizeFileName('<img src=x onerror=alert(1)>.csv')).toBe(
      'img src=x onerror=alert(1).csv',
    );
    expect(sanitizeFileName('')).toBe('upload');
    expect(sanitizeFileName('x'.repeat(500)).length).toBe(180);
  });

  it('refuses encrypted and ZIP64 archives rather than half-parsing them', () => {
    const bytes = makeXlsx([{ name: 'S1', rows: [['name'], ['A']] }]);
    // Flip the EOCD central-directory offset to the ZIP64 marker.
    const eocd = bytes.length - 22;
    const zip64 = Buffer.from(bytes);
    zip64.writeUInt32LE(0xffffffff, eocd + 16);
    expectCode(() => parseXlsx(zip64), 'FILE_UNSUPPORTED');
  });
});
