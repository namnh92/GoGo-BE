import { describe, expect, it } from 'vitest';
import { fakedProviders, warnFakedProviders } from './provider-selection';

const KEY = 'AIzaSyExampleNotARealCredential0000000000';

/** Every key present, Routes opt-in off — the shape a healthy deploy has. */
const HEALTHY = {
  GOOGLE_PLACES_API_KEY: KEY,
  GOOGLE_SHEETS_API_KEY: KEY,
  GOOGLE_ROUTES_API_KEY: KEY,
  FLAG_ROUTES_API: false,
};

describe('PI-BE-021 — faked provider reporting', () => {
  it('reports nothing when every key is present', () => {
    expect(fakedProviders(HEALTHY)).toEqual([]);
  });

  it('reports the two Places ports when only the Places key is missing', () => {
    const faked = fakedProviders({ ...HEALTHY, GOOGLE_PLACES_API_KEY: '' });
    expect(faked.map((f) => f.port)).toEqual(['PLACE_PROVIDER', 'AREA_AUTOCOMPLETE']);
  });

  it('reports Sheets on its own key alone, never on the Places key', () => {
    // The fallback GOOGLE_SHEETS_API_KEY -> GOOGLE_MAPS_API_KEY is gone
    // (BE-BFF-P1 #271). A Places-restricted key cannot read a sheet, so
    // treating it as cover reported a working provider that was not one.
    const faked = fakedProviders({ ...HEALTHY, GOOGLE_SHEETS_API_KEY: '' });
    expect(faked.map((f) => f.port)).toEqual(['SHEETS_PROVIDER']);
  });

  it('reports all three when no Google key is set at all', () => {
    const faked = fakedProviders({
      ...HEALTHY,
      GOOGLE_PLACES_API_KEY: '',
      GOOGLE_SHEETS_API_KEY: '',
    });
    expect(faked.map((f) => f.port)).toEqual([
      'PLACE_PROVIDER',
      'AREA_AUTOCOMPLETE',
      'SHEETS_PROVIDER',
    ]);
  });

  it('warns once per faked port, naming the one env var that would fix it', () => {
    const lines: { meta: Record<string, unknown>; message: string }[] = [];
    warnFakedProviders(
      { ...HEALTHY, GOOGLE_PLACES_API_KEY: '', GOOGLE_SHEETS_API_KEY: '' },
      (meta, message) => lines.push({ meta, message }),
    );

    expect(lines).toHaveLength(3);
    expect(lines.find((l) => l.meta.port === 'SHEETS_PROVIDER')?.meta.missing_env).toBe(
      'GOOGLE_SHEETS_API_KEY',
    );
    expect(lines.find((l) => l.meta.port === 'PLACE_PROVIDER')?.meta.missing_env).toBe(
      'GOOGLE_PLACES_API_KEY',
    );
  });

  it('says nothing about Routes while the flag is off', () => {
    // Without FLAG_ROUTES_API the straight-line estimate is the product's
    // answer, not a stand-in. Warning here would be the line operators learn
    // to skip, and they would skip the other three with it.
    expect(fakedProviders({ ...HEALTHY, GOOGLE_ROUTES_API_KEY: '' })).toEqual([]);
  });

  it('reports Routes when the flag is on and the key is not there', () => {
    // Someone turned real travel times on and is silently getting estimates.
    const faked = fakedProviders({
      ...HEALTHY,
      FLAG_ROUTES_API: true,
      GOOGLE_ROUTES_API_KEY: '',
    });
    expect(faked.map((f) => f.port)).toEqual(['TRAVEL_TIME_PROVIDER']);
    expect(faked[0]?.envVar).toBe('GOOGLE_ROUTES_API_KEY');
  });

  it('never puts a credential in the log line', () => {
    const lines: { meta: Record<string, unknown>; message: string }[] = [];
    warnFakedProviders({ ...HEALTHY, GOOGLE_PLACES_API_KEY: '' }, (meta, message) =>
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
