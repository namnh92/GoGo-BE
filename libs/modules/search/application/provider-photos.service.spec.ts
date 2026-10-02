import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderInvalidRequestError,
  type PlacePhotoDisplayPort,
  type ProviderDisplayPhotoRef,
  type ProviderPhotoMedia,
} from '@gogo/providers';
import { PROVIDER_PHOTOS_DEADLINE_MS, ProviderPhotosService } from './provider-photos.service';

/**
 * GoGo-BE#509 review round 1 (Sol, @081a918): F-01 deadline cancels the work,
 * F-02 one fresh-name retry, F-04 exactly one terminal outcome per request.
 */

const PLACE = '11111111-1111-4111-8111-111111111111';
const GOOGLE_ID = 'ChIJ-svc';
const JPEG: ProviderPhotoMedia = { contentType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) };

const ref = (name: string, author = 'Lan'): ProviderDisplayPhotoRef => ({
  reference: `places/${GOOGLE_ID}/photos/${name}`,
  widthPx: 100,
  heightPx: 80,
  authorAttributions: [{ displayName: author, uri: null, photoUri: null }],
  googleMapsUri: null,
});

/** `googleIdOf` first, then the flag lookup — the order the service asks in. */
function fakeDb() {
  let call = 0;
  return {
    execute: vi.fn(async () => {
      call += 1;
      if (call === 1) return { rows: [{ provider_id: GOOGLE_ID, legacy_id: null }] };
      return { rows: [{ environment: 'all', platform: 'all', enabled: true, payload: null }] };
    }),
  };
}

const CONFIG = {
  APP_ENV: 'dev' as const,
  FLAG_PLACE_PROVIDER_PHOTOS: false,
  PLACE_DISPLAY_DAILY_MAX_CALLS: 100,
  PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD: 1,
  PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_PHOTOMEDIA: 100,
};

function setup(port: PlacePhotoDisplayPort, grants = Infinity) {
  const outcomes: string[] = [];
  let granted = 0;
  const reserve = vi.fn(async () => {
    if (granted >= grants) return { ok: false as const, reason: 'unit_ceiling' as const };
    granted += 1;
    return {
      ok: true as const,
      reserved: { calls: 1, units: 1, costMicros: 7000 },
      scopeTotals: { calls: granted, costMicros: 7000 * granted },
      operationUnits: granted,
    };
  });
  const service = new ProviderPhotosService(
    fakeDb() as never,
    port,
    CONFIG,
    {
      increment: (name: string, labels?: Record<string, unknown>) => {
        if (name === 'place_provider_photos_total') outcomes.push(String(labels?.['outcome']));
      },
      observe: () => undefined,
    } as never,
    { reserve } as never,
  );
  return { service, outcomes, reserve };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('ProviderPhotosService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('F-01: the deadline stops the work — no media call, no second outcome, signal aborted', async () => {
    let release: (v: { providerPlaceId: string; photos: ProviderDisplayPhotoRef[] }) => void = () =>
      undefined;
    const signals: (AbortSignal | undefined)[] = [];
    const mediaCalls: string[] = [];
    const port: PlacePhotoDisplayPort = {
      photoRefs: (_id: string, options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal);
        return new Promise((resolve) => (release = resolve));
      },
      photoMedia: async (reference: string) => {
        mediaCalls.push(reference);
        return JPEG;
      },
    } as PlacePhotoDisplayPort;
    const { service, outcomes, reserve } = setup(port);

    const pending = service.photos(PLACE);
    await flush();
    await vi.advanceTimersByTimeAsync(PROVIDER_PHOTOS_DEADLINE_MS);
    expect(await pending).toMatchObject({ status: 'unavailable', photos: [] });

    // Google answers late. Nothing may happen with that answer.
    release({ providerPlaceId: GOOGLE_ID, photos: [ref('A')] });
    await flush();
    await vi.advanceTimersByTimeAsync(1000);

    expect(mediaCalls).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
    expect(outcomes).toEqual(['timeout']);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('F-02: an expired photo name is refetched once and served with its fresh credit', async () => {
    const refsCalls: number[] = [];
    const port: PlacePhotoDisplayPort = {
      photoRefs: async () => {
        refsCalls.push(1);
        return {
          providerPlaceId: GOOGLE_ID,
          photos: refsCalls.length === 1 ? [ref('Stale', 'Old')] : [ref('Fresh', 'New')],
        };
      },
      photoMedia: async (reference: string) => {
        if (reference.endsWith('/Stale')) {
          throw new ProviderInvalidRequestError('google.places', 'NOT_FOUND');
        }
        return JPEG;
      },
    } as PlacePhotoDisplayPort;
    const { service, outcomes, reserve } = setup(port);

    const result = await service.photos(PLACE);
    expect(result.status).toBe('ok');
    expect(result.photos).toHaveLength(1);
    expect(result.photos[0]!.authorAttributions[0]!.displayName).toBe('New');
    expect(refsCalls).toHaveLength(2);
    // The retried media call is billed, so it is reserved.
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual(['served']);
  });

  it('F-02: the refetch happens once — a second expiry is not chased', async () => {
    let refs = 0;
    const port: PlacePhotoDisplayPort = {
      photoRefs: async () => {
        refs += 1;
        return { providerPlaceId: GOOGLE_ID, photos: [ref(`Stale${refs}`)] };
      },
      photoMedia: async () => {
        throw new ProviderInvalidRequestError('google.places', 'NOT_FOUND');
      },
    } as PlacePhotoDisplayPort;
    const { service, outcomes } = setup(port);
    expect(await service.photos(PLACE)).toMatchObject({ status: 'unavailable', photos: [] });
    expect(refs).toBe(2);
    expect(outcomes).toEqual(['provider_error']);
  });

  it('F-04: a valid lookup with no photos counts `empty`, once', async () => {
    const port = {
      photoRefs: async () => ({ providerPlaceId: GOOGLE_ID, photos: [] }),
      photoMedia: async () => JPEG,
    } as PlacePhotoDisplayPort;
    const { service, outcomes } = setup(port);
    expect(await service.photos(PLACE)).toMatchObject({ status: 'ok', photos: [] });
    expect(outcomes).toEqual(['empty']);
  });

  it('F-04: a budget that runs out part-way is one `served`, not `served` + `refused_budget`', async () => {
    const port = {
      photoRefs: async () => ({
        providerPlaceId: GOOGLE_ID,
        photos: [ref('A'), ref('B'), ref('C')],
      }),
      photoMedia: async () => JPEG,
    } as PlacePhotoDisplayPort;
    const { service, outcomes } = setup(port, 1);
    const result = await service.photos(PLACE);
    expect(result.photos).toHaveLength(1);
    expect(outcomes).toEqual(['served']);
  });

  it('F-04: a budget refused before any photo is one `refused_budget`', async () => {
    const port = {
      photoRefs: async () => ({ providerPlaceId: GOOGLE_ID, photos: [ref('A')] }),
      photoMedia: async () => JPEG,
    } as PlacePhotoDisplayPort;
    const { service, outcomes } = setup(port, 0);
    expect(await service.photos(PLACE)).toMatchObject({ status: 'budget_exhausted' });
    expect(outcomes).toEqual(['refused_budget']);
  });
});
