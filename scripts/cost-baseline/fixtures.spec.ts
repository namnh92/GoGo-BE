import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadFixtures, loadSheet, multipart } from './scenarios';
import { FIXTURES_DIR, applyFieldMask, loadCatalog } from './stub-google';

const fixtures = loadFixtures();
const catalog = loadCatalog();

/**
 * The fixtures are the experiment. A drift in them is a different baseline
 * wearing the same name, so their shape is asserted rather than trusted.
 */
describe('#336 pinned fixtures', () => {
  it('pins scenario E at exactly twenty rows in the declared mix', () => {
    const lines = loadSheet(fixtures).toString('utf8').trim().split('\n');
    const rows = lines.slice(1);
    expect(rows).toHaveLength(20);

    const withUrl = rows.filter((r) => r.includes('place_id='));
    const invalid = rows.filter((r) => r.includes('example.com'));
    const nameOnly = rows.filter((r) => /,,cafe,/.test(r));
    const { composition } = fixtures.E;
    expect(withUrl).toHaveLength(composition.directIdNew! + composition.directIdCatalogued!);
    expect(invalid).toHaveLength(composition.invalid!);
    expect(nameOnly).toHaveLength(composition.nameOnly!);
  });

  it('gives every scenario its own place ids, so one cannot pre-import another', () => {
    const idsIn = (urls: string[]) =>
      urls.map((u) => /[?&]place_id=([\w-]+)/.exec(u)?.[1] ?? u.split('/').pop()!);
    const catalogued = fixtures.seededCatalog.map((s) => s.providerPlaceId);
    const dNew = idsIn(fixtures.D.urls);
    const sheet = loadSheet(fixtures).toString('utf8');
    const eNew = [...sheet.matchAll(/place_id=([\w-]+)/g)]
      .map((m) => m[1]!)
      .filter((id) => !catalogued.includes(id));

    expect(dNew.filter((id) => catalogued.includes(id))).toEqual([]);
    expect(dNew.filter((id) => eNew.includes(id))).toEqual([]);
  });

  it('answers every pinned id from the stub catalog, and nothing else', () => {
    const referenced = new Set<string>();
    for (const s of fixtures.seededCatalog) referenced.add(s.providerPlaceId);
    for (const url of [...fixtures.C1.urls, ...fixtures.D.urls]) {
      referenced.add(/[?&]place_id=([\w-]+)/.exec(url)![1]!);
    }
    for (const target of Object.values(fixtures.C2.expandsTo)) {
      referenced.add(/[?&]place_id=([\w-]+)/.exec(target)![1]!);
    }
    for (const m of loadSheet(fixtures)
      .toString('utf8')
      .matchAll(/place_id=([\w-]+)/g)) {
      referenced.add(m[1]!);
    }
    for (const ids of Object.values(catalog.searchText)) for (const id of ids) referenced.add(id);

    const missing = [...referenced].filter((id) => !(id in catalog.places));
    expect(missing, 'every pinned id must have a pinned answer').toEqual([]);
  });

  it('keys text search on the query the resolver actually composes', () => {
    // place-import-job.service.ts builds `[name, district, city]`; a change to
    // that composition must break here rather than silently return no
    // candidates and quietly halve scenario E's cost.
    for (const query of Object.keys(catalog.searchText)) {
      expect(query).toMatch(/ Quận 1 Hồ Chí Minh$/);
      const name = query.replace(/ Quận 1 Hồ Chí Minh$/, '');
      expect(loadSheet(fixtures).toString('utf8')).toContain(`${name},Hồ Chí Minh,Quận 1,,`);
    }
  });

  it('stores no provider content — every fixture id is synthetic', () => {
    const ids = Object.keys(catalog.places);
    expect(ids.length).toBeGreaterThan(0);
    // A real Google Place ID does not look like this. The prefix is the
    // reviewable proof that nothing here was copied out of a Google response
    // (plan §7).
    expect(ids.every((id) => id.startsWith('GOGOBASE_'))).toBe(true);
  });

  it('is committed as text a reviewer can diff', () => {
    for (const file of ['scenarios.json', 'google-catalog.json', 'scenario-e-sheet.csv']) {
      expect(readFileSync(path.join(FIXTURES_DIR, file), 'utf8').length).toBeGreaterThan(0);
    }
  });
});

describe('#336 stub transport', () => {
  it('honours the field mask, so a cheaper tier really returns less', () => {
    const place = catalog.places[Object.keys(catalog.places)[0]!]!;
    const core = applyFieldMask(place, 'id,displayName,formattedAddress,location,businessStatus');
    expect(core).toHaveProperty('id');
    expect(core).not.toHaveProperty('rating');
    expect(core).not.toHaveProperty('regularOpeningHours');
  });

  it('passes everything through when no mask is sent', () => {
    const place = catalog.places[Object.keys(catalog.places)[0]!]!;
    expect(applyFieldMask(place, undefined)).toBe(place);
  });
});

describe('#336 multipart encoder', () => {
  it('uses a fixed boundary, so two runs send identical bytes', () => {
    const a = multipart([{ name: 'mode', value: Buffer.from('dry_run') }]);
    const b = multipart([{ name: 'mode', value: Buffer.from('dry_run') }]);
    expect(a.body.equals(b.body)).toBe(true);
    expect(a.contentType).toBe(b.contentType);
  });

  it('carries a filename and content type for a file part', () => {
    const { body } = multipart([
      { name: 'file', filename: 'x.csv', contentType: 'text/csv', value: Buffer.from('a,b\n') },
    ]);
    const text = body.toString('utf8');
    expect(text).toContain('filename="x.csv"');
    expect(text).toContain('Content-Type: text/csv');
    expect(text.endsWith('--\r\n')).toBe(true);
  });
});
