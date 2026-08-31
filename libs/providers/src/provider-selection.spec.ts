import { describe, expect, it } from 'vitest';
import { fakedProviders, warnFakedProviders } from './provider-selection';

const KEY = 'AIzaSyExampleNotARealCredential0000000000';

describe('PI-BE-021 — faked provider reporting', () => {
  it('reports nothing when every key is present', () => {
    expect(fakedProviders({ GOOGLE_MAPS_API_KEY: KEY, GOOGLE_SHEETS_API_KEY: KEY })).toEqual([]);
  });

  it('reports the two Maps ports when only the Maps key is missing', () => {
    // Sheets has a key of its own here, so it is real and must not be reported.
    const faked = fakedProviders({ GOOGLE_MAPS_API_KEY: '', GOOGLE_SHEETS_API_KEY: KEY });
    expect(faked.map((f) => f.port)).toEqual(['PLACE_PROVIDER', 'AREA_AUTOCOMPLETE']);
  });

  it('does not report Sheets when the Maps key covers it', () => {
    // providers.module.ts and the worker both fall back GOOGLE_SHEETS_API_KEY ->
    // GOOGLE_MAPS_API_KEY. A report that ignored the fallback would warn about a
    // port that is in fact real, and a warning that cries wolf gets filtered.
    const faked = fakedProviders({ GOOGLE_MAPS_API_KEY: KEY, GOOGLE_SHEETS_API_KEY: '' });
    expect(faked.map((f) => f.port)).not.toContain('SHEETS_PROVIDER');
  });

  it('reports all three when no Google key is set at all', () => {
    const faked = fakedProviders({ GOOGLE_MAPS_API_KEY: '', GOOGLE_SHEETS_API_KEY: '' });
    expect(faked.map((f) => f.port)).toEqual([
      'PLACE_PROVIDER',
      'AREA_AUTOCOMPLETE',
      'SHEETS_PROVIDER',
    ]);
  });

  it('warns once per faked port, naming the env vars that would fix it', () => {
    const lines: { meta: Record<string, unknown>; message: string }[] = [];
    warnFakedProviders({ GOOGLE_MAPS_API_KEY: '', GOOGLE_SHEETS_API_KEY: '' }, (meta, message) =>
      lines.push({ meta, message }),
    );

    expect(lines).toHaveLength(3);
    const sheets = lines.find((l) => l.meta.port === 'SHEETS_PROVIDER');
    expect(sheets?.meta.missing_env).toEqual(['GOOGLE_SHEETS_API_KEY', 'GOOGLE_MAPS_API_KEY']);
  });

  it('never puts a credential in the log line', () => {
    const lines: { meta: Record<string, unknown>; message: string }[] = [];
    warnFakedProviders({ GOOGLE_MAPS_API_KEY: '', GOOGLE_SHEETS_API_KEY: KEY }, (meta, message) =>
      lines.push({ meta, message }),
    );

    // Not just "the key is absent from meta": a length or a prefix is still a
    // fact about a credential, and the adapter docblock promises neither leaks.
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(KEY.slice(0, 8));
    expect(serialized).not.toContain(String(KEY.length));
  });
});
