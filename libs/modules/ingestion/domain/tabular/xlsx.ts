import { INGEST_LIMITS, IngestFileError } from './limits';
import type { SheetGrid } from './types';
import { ZipArchive } from './zip';

/**
 * PI-BE-011 — XLSX reader over {@link ZipArchive}. Reads values only: shared
 * strings, inline strings and numbers. Formulas are never evaluated, macros
 * are rejected outright, and external/DDE references are ignored because the
 * cached `<v>` value is all we ever look at.
 */

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Out-of-range code points are left as literal text — never thrown at the caller. */
function codePoint(value: number): string | null {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : null;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return codePoint(Number.parseInt(entity.slice(2), 16)) ?? whole;
    }
    if (entity.startsWith('#')) return codePoint(Number.parseInt(entity.slice(1), 10)) ?? whole;
    // Only the five predefined entities are expanded — no DTD, no nesting, so
    // an entity-expansion bomb has nothing to expand.
    return XML_ENTITIES[entity] ?? whole;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]!) : undefined;
}

/** "AB12" → 27 (zero-based column index). */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function readSharedStrings(zip: ZipArchive): string[] {
  if (!zip.has('xl/sharedStrings.xml')) return [];
  const xml = zip.read('xl/sharedStrings.xml').toString('utf8');
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    const inner = si[1] ?? '';
    // Rich text splits one string across several <t> runs.
    let text = '';
    for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += decodeXml(t[1]!);
    out.push(text);
  }
  return out;
}

type SheetRef = { name: string; path: string };

function readSheetRefs(zip: ZipArchive): SheetRef[] {
  const workbook = zip.read('xl/workbook.xml').toString('utf8');
  const rels = zip.has('xl/_rels/workbook.xml.rels')
    ? zip.read('xl/_rels/workbook.xml.rels').toString('utf8')
    : '';
  const relTargets = new Map<string, string>();
  for (const r of rels.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = attr(r[0], 'Id');
    const target = attr(r[0], 'Target');
    if (id && target) relTargets.set(id, target.replace(/^\/?(xl\/)?/, ''));
  }

  const refs: SheetRef[] = [];
  let fallbackIndex = 0;
  for (const s of workbook.matchAll(/<sheet\b[^>]*\/>/g)) {
    fallbackIndex += 1;
    const name = attr(s[0], 'name') ?? `Sheet${fallbackIndex}`;
    const rid = attr(s[0], 'r:id') ?? attr(s[0], 'id');
    const target = rid ? relTargets.get(rid) : undefined;
    refs.push({ name, path: `xl/${target ?? `worksheets/sheet${fallbackIndex}.xml`}` });
  }
  return refs;
}

function readSheet(zip: ZipArchive, ref: SheetRef, shared: string[]): SheetGrid {
  const xml = zip.read(ref.path).toString('utf8');
  const rows: string[][] = [];

  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const body = rowMatch[2] ?? '';
    const cells: string[] = [];
    for (const cellMatch of body.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const tag = cellMatch[1] ?? cellMatch[3] ?? '';
      const inner = cellMatch[2] ?? '';
      const ref2 = attr(`<c ${tag}>`, 'r');
      const type = attr(`<c ${tag}>`, 't') ?? 'n';

      let value = '';
      if (type === 'inlineStr') {
        for (const t of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) value += decodeXml(t[1]!);
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const rawValue = v ? decodeXml(v[1]!) : '';
        if (type === 's') value = shared[Number(rawValue)] ?? '';
        else if (type === 'b') value = rawValue === '1' ? 'TRUE' : 'FALSE';
        else value = rawValue;
      }

      if (value.length > INGEST_LIMITS.maxCellChars) {
        throw new IngestFileError(
          'CELL_TOO_LONG',
          `Cell exceeds ${INGEST_LIMITS.maxCellChars} chars`,
        );
      }
      // Sparse sheets skip empty cells; the column ref restores alignment.
      // A malformed ref falls back to append order rather than a negative index.
      const parsed = ref2 ? columnIndex(ref2) : -1;
      const index = parsed >= 0 ? parsed : cells.length;
      if (index >= INGEST_LIMITS.maxColumns) {
        throw new IngestFileError(
          'TOO_MANY_COLUMNS',
          `More than ${INGEST_LIMITS.maxColumns} columns`,
        );
      }
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    if (cells.some((c) => c !== '')) rows.push(cells);
    if (rows.length > INGEST_LIMITS.maxRows + 1) {
      throw new IngestFileError('TOO_MANY_ROWS', `More than ${INGEST_LIMITS.maxRows} rows`);
    }
  }

  const [header = [], ...data] = rows;
  return { name: ref.name, headers: header.map((h) => h.trim()), rows: data };
}

/** Every tab in the workbook, in workbook order. */
export function parseXlsx(bytes: Buffer): SheetGrid[] {
  if (bytes.byteLength > INGEST_LIMITS.maxFileBytes) {
    throw new IngestFileError('FILE_TOO_LARGE', 'File exceeds the 20 MB limit');
  }
  const zip = ZipArchive.open(bytes);
  if (zip.has('xl/vbaProject.bin')) {
    throw new IngestFileError('FILE_MACRO_NOT_ALLOWED', 'Macro-enabled workbooks are rejected');
  }
  const refs = readSheetRefs(zip);
  if (refs.length === 0) throw new IngestFileError('FILE_CORRUPT', 'Workbook has no sheets');

  const grids: SheetGrid[] = [];
  const shared = readSharedStrings(zip);
  let totalRows = 0;
  for (const ref of refs) {
    if (!zip.has(ref.path)) continue;
    const grid = readSheet(zip, ref, shared);
    totalRows += grid.rows.length;
    if (totalRows > INGEST_LIMITS.maxRows) {
      throw new IngestFileError('TOO_MANY_ROWS', `More than ${INGEST_LIMITS.maxRows} rows`);
    }
    grids.push(grid);
  }
  return grids;
}
