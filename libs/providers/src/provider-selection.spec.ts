import { describe, expect, it } from 'vitest';
import {
  fakedProviders,
  pushProviderStatus,
  resolvePushProviderMode,
  placeProviderStatus,
  resolvePlaceProviderMode,
  warnFakedProviders,
} from './provider-selection';

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

describe('#279 — place provider mode is decided before anyone looks at a secret', () => {
  it('follows the build when unset: a deployed environment means google', () => {
    expect(resolvePlaceProviderMode({ NODE_ENV: 'production' })).toBe('google');
  });

  it('follows the build when unset: a laptop and the test suite mean fake', () => {
    expect(resolvePlaceProviderMode({ NODE_ENV: 'development' })).toBe('fake');
    expect(resolvePlaceProviderMode({ NODE_ENV: 'test' })).toBe('fake');
  });

  it('lets an explicit setting win in both directions', () => {
    expect(resolvePlaceProviderMode({ NODE_ENV: 'production', PLACE_PROVIDER_MODE: 'fake' })).toBe(
      'fake',
    );
    expect(
      resolvePlaceProviderMode({ NODE_ENV: 'development', PLACE_PROVIDER_MODE: 'google' }),
    ).toBe('google');
  });

  it('does NOT fall back to the fake when google mode has no credential', () => {
    // The defect in one assertion. Binding the fake here is what answered a
    // real Google Maps link with "no such place".
    expect(placeProviderStatus({ NODE_ENV: 'production', GOOGLE_PLACES_API_KEY: '' })).toEqual({
      mode: 'google',
      provider: 'unconfigured',
      ready: false,
      reason: 'MISSING_CREDENTIAL',
    });
  });

  it('is ready on google with a credential', () => {
    expect(
      placeProviderStatus({ NODE_ENV: 'production', GOOGLE_PLACES_API_KEY: 'AIzaExample' }),
    ).toEqual({ mode: 'google', provider: 'google', ready: true });
  });

  it('is ready on a deliberately fake environment, credential or not', () => {
    expect(
      placeProviderStatus({
        NODE_ENV: 'production',
        PLACE_PROVIDER_MODE: 'fake',
        GOOGLE_PLACES_API_KEY: '',
      }),
    ).toEqual({ mode: 'fake', provider: 'fake', ready: true });
  });

  it('stops calling the port "bound to a fake" when it is not', () => {
    // The warn line has to stay true: in google mode the effect sentence
    // ("answers from a fixed in-memory set") would describe something that no
    // longer happens.
    const faked = fakedProviders({
      ...HEALTHY,
      GOOGLE_PLACES_API_KEY: '',
      PLACE_PROVIDER_MODE: 'google',
    });

    expect(faked.map((f) => f.port)).not.toContain('PLACE_PROVIDER');
    expect(faked.map((f) => f.port)).not.toContain('AREA_AUTOCOMPLETE');
  });

  it('never puts a credential in the status', () => {
    const status = placeProviderStatus({
      NODE_ENV: 'production',
      GOOGLE_PLACES_API_KEY: 'AIzaSyExampleNotARealCredential0000000000',
    });

    expect(JSON.stringify(status)).not.toContain('AIza');
  });
});

describe('pushProviderStatus (#193)', () => {
  const creds = {
    ONESIGNAL_APP_ID: '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
    ONESIGNAL_REST_API_KEY: 'os_v2_app_key',
  };

  it('a deployed build is on OneSignal unless told otherwise; a laptop is on the fake', () => {
    expect(resolvePushProviderMode({ NODE_ENV: 'production' })).toBe('onesignal');
    expect(resolvePushProviderMode({ NODE_ENV: 'development' })).toBe('fake');
    expect(resolvePushProviderMode({ NODE_ENV: 'test' })).toBe('fake');
    expect(resolvePushProviderMode({ NODE_ENV: 'production', PUSH_PROVIDER_MODE: 'fake' })).toBe(
      'fake',
    );
    expect(
      resolvePushProviderMode({ NODE_ENV: 'development', PUSH_PROVIDER_MODE: 'onesignal' }),
    ).toBe('onesignal');
  });

  it('is identical for every deployed environment: the value decides, not the name', () => {
    for (const env of ['dev', 'staging', 'prod']) {
      void env; // APP_ENV is deliberately not an input here.
      expect(pushProviderStatus({ NODE_ENV: 'production', ...creds })).toEqual({
        mode: 'onesignal',
        provider: 'onesignal',
        ready: true,
      });
    }
  });

  it('a missing credential in onesignal mode binds the refusing provider, never the fake', () => {
    expect(
      pushProviderStatus({ NODE_ENV: 'production', ...creds, ONESIGNAL_REST_API_KEY: '' }),
    ).toEqual({
      mode: 'onesignal',
      provider: 'unconfigured',
      ready: false,
      reason: 'MISSING_CREDENTIAL',
    });
    expect(pushProviderStatus({ NODE_ENV: 'production', ...creds, ONESIGNAL_APP_ID: '' })).toEqual({
      mode: 'onesignal',
      provider: 'unconfigured',
      ready: false,
      reason: 'MISSING_CREDENTIAL',
    });
  });

  it('an app id that is not a UUID is a paste error, not a configuration', () => {
    expect(
      pushProviderStatus({ NODE_ENV: 'production', ...creds, ONESIGNAL_APP_ID: 'gogo-dev' }),
    ).toMatchObject({ provider: 'unconfigured', ready: false, reason: 'INVALID_APP_ID' });
  });

  it('fake mode is reported as pretending; onesignal mode without a key is not', () => {
    expect(fakedProviders({ ...HEALTHY, PUSH_PROVIDER_MODE: 'fake' }).map((f) => f.port)).toEqual([
      'PUSH_PROVIDER',
    ]);
    expect(fakedProviders({ ...HEALTHY, PUSH_PROVIDER_MODE: 'onesignal' })).toEqual([]);
  });
});
