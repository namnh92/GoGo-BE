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

const GOOGLE_ID = 'ChIJ-svc';
const JPEG: ProviderPhotoMedia = { contentType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) };

const ref = (name: string, author = 'Lan'): ProviderDisplayPhotoRef => ({
  reference: `places/${GOOGLE_ID}/photos/${name}`,
  widthPx: 100,
  heightPx: 80,
  authorAttributions: [{ displayName: author, uri: null, photoUri: null }],
  googleMapsUri: null,
});

function fakeDb() {
  return {
    execute: vi.fn(async () => ({
      rows: [{ environment: 'all', platform: 'all', enabled: true, payload: null }],
    })),
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
        if (name === 'provider_photo_requests_total') outcomes.push(String(labels?.['outcome']));
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

    const pending = service.firstForProvider(GOOGLE_ID);
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

    const result = await service.firstForProvider(GOOGLE_ID);
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
    expect(await service.firstForProvider(GOOGLE_ID)).toMatchObject({
      status: 'unavailable',
      photos: [],
    });
    expect(refs).toBe(2);
    expect(outcomes).toEqual(['provider_error']);
  });

  it('F-04: a valid lookup with no photos counts `empty`, once', async () => {
    const port = {
      photoRefs: async () => ({ providerPlaceId: GOOGLE_ID, photos: [] }),
      photoMedia: async () => JPEG,
    } as PlacePhotoDisplayPort;
    const { service, outcomes } = setup(port);
    expect(await service.firstForProvider(GOOGLE_ID)).toMatchObject({ status: 'ok', photos: [] });
    expect(outcomes).toEqual(['empty']);
  });

  it('F-04: a budget refused before any photo is one `refused_budget`', async () => {
    const port = {
      photoRefs: async () => ({ providerPlaceId: GOOGLE_ID, photos: [ref('A')] }),
      photoMedia: async () => JPEG,
    } as PlacePhotoDisplayPort;
    const { service, outcomes } = setup(port, 0);
    expect(await service.firstForProvider(GOOGLE_ID)).toMatchObject({ status: 'budget_exhausted' });
    expect(outcomes).toEqual(['refused_budget']);
  });
});

describe('#786 single candidate photo', () => {
  function candidateService(enabled = true) {
    const port = {
      photoRefs: vi.fn(async () => ({
        providerPlaceId: GOOGLE_ID,
        photos: [ref('one'), ref('two')],
      })),
      photoMedia: vi.fn(async () => JPEG),
    };
    const reserve = vi.fn(async () => ({ ok: true }));
    const db = {
      execute: vi.fn(async () => ({
        rows: [{ environment: 'all', platform: 'all', enabled, payload: null }],
      })),
    };
    return {
      port,
      reserve,
      service: new ProviderPhotosService(db as never, port as never, CONFIG, undefined, {
        reserve,
      } as never),
    };
  }

  it('resolve returns one BFF reference and credits without buying or exposing a Google ref', async () => {
    const { service, port, reserve } = candidateService();
    const result = await service.candidateReference(GOOGLE_ID);
    expect(result).toMatchObject({
      url: `/v1/places/google-provider-photo/${GOOGLE_ID}`,
      provider: 'google',
      attribution: 'Google Maps',
      authorAttributions: [{ displayName: 'Lan' }],
    });
    expect(JSON.stringify(result)).not.toContain('/photos/');
    expect(port.photoMedia).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('flag off skips references and media for both preview and approval', async () => {
    const { service, port } = candidateService(false);
    expect(await service.candidateReference(GOOGLE_ID)).toBeUndefined();
    expect(await service.firstForProvider(GOOGLE_ID)).toMatchObject({
      status: 'disabled',
      photos: [],
    });
    expect(port.photoRefs).not.toHaveBeenCalled();
    expect(port.photoMedia).not.toHaveBeenCalled();
  });

  it('proxy buys at most one first photo using existing reservation', async () => {
    const { service, port, reserve } = candidateService();
    const result = await service.firstForProvider(GOOGLE_ID);
    expect(result.photos).toHaveLength(1);
    expect(port.photoMedia).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('missing photos and identity changes omit candidate reference', async () => {
    const { service, port } = candidateService();
    port.photoRefs.mockResolvedValueOnce({ providerPlaceId: GOOGLE_ID, photos: [] });
    expect(await service.candidateReference(GOOGLE_ID)).toBeUndefined();
    port.photoRefs.mockResolvedValueOnce({ providerPlaceId: 'different', photos: [ref('one')] });
    expect(await service.candidateReference(GOOGLE_ID)).toBeUndefined();
  });
});

describe('#797 reference-only probe', () => {
  function probeSetup() {
    const db = {
      execute: vi.fn(async () => ({
        rows: [{ environment: 'all', platform: 'all', enabled: true, payload: null }],
      })),
    };
    const port = {
      photoRefs: vi.fn(async () => ({ providerPlaceId: GOOGLE_ID, photos: [ref('first')] })),
      photoMedia: vi.fn(),
    };
    const reserve = vi.fn();
    const service = new ProviderPhotosService(db as never, port as never, CONFIG, undefined, {
      reserve,
    } as never);
    return { db, port, reserve, service };
  }
  it('distinguishes photos, empty, identity mismatch and errors without media or budget writes', async () => {
    const f = probeSetup();
    expect(await f.service.probeForProvider(GOOGLE_ID)).toEqual({ status: 'ok', hasPhoto: true });
    f.port.photoRefs.mockResolvedValue({ providerPlaceId: GOOGLE_ID, photos: [] });
    expect(await f.service.probeForProvider(GOOGLE_ID)).toEqual({ status: 'ok', hasPhoto: false });
    f.port.photoRefs.mockResolvedValue({ providerPlaceId: 'other', photos: [] });
    expect(await f.service.probeForProvider(GOOGLE_ID)).toEqual({
      status: 'unavailable',
      hasPhoto: false,
    });
    f.port.photoRefs.mockRejectedValue(new Error('secret'));
    expect(await f.service.probeForProvider(GOOGLE_ID)).toEqual({
      status: 'unavailable',
      hasPhoto: false,
    });
    expect(f.port.photoMedia).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('skips all calls when disabled', async () => {
    const f = probeSetup();
    f.db.execute.mockResolvedValue({
      rows: [{ environment: 'all', platform: 'all', enabled: false, payload: null }],
    });
    expect(await f.service.probeForProvider(GOOGLE_ID)).toEqual({
      status: 'disabled',
      hasPhoto: false,
    });
    expect(f.port.photoRefs).not.toHaveBeenCalled();
  });
  it('aborts reference lookup at the existing deadline', async () => {
    vi.useFakeTimers();
    try {
      const f = probeSetup();
      let signal: AbortSignal | undefined;
      f.port.photoRefs.mockImplementation((_id?: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise(() => undefined);
      });
      const pending = f.service.probeForProvider(GOOGLE_ID);
      await vi.advanceTimersByTimeAsync(PROVIDER_PHOTOS_DEADLINE_MS);
      expect(await pending).toEqual({ status: 'unavailable', hasPhoto: false });
      expect(signal?.aborted).toBe(true);
      expect(f.port.photoMedia).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

it('#801 cancels candidate photoRefs at the remaining parent deadline', async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const photoRefs = vi.fn((_id: string, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<never>(() => {});
    });
    const service = new ProviderPhotosService(
      {
        execute: vi.fn().mockResolvedValue({
          rows: [{ environment: 'all', platform: 'all', enabled: true, payload: null }],
        }),
      } as never,
      { photoRefs, photoMedia: vi.fn() } as never,
      CONFIG,
    );
    const controller = new AbortController();
    const work = service.candidateReference(GOOGLE_ID, {
      signal: controller.signal,
      deadline: performance.now() + 250,
    });
    await vi.advanceTimersByTimeAsync(251);
    expect(await work).toBeUndefined();
    expect(photoRefs).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    const canceled = new AbortController();
    canceled.abort();
    expect(
      await service.candidateReference(GOOGLE_ID, { signal: canceled.signal }),
    ).toBeUndefined();
    expect(photoRefs).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
