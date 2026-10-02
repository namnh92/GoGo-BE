import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GooglePlacesAdapter,
  PHOTO_DISPLAY_FIELD_MASK,
  toDisplayPhotos,
} from './google-places.adapter';
import { safeProviderUri } from './provider-links';
import { ProviderCallAbortedError } from './ports';
import { resetBreakers } from './resilience';

/**
 * GoGo-BE#509 — transient display photos (owner decision 2026-10-02, ADR-0029).
 *
 * What these hold: the display operations ask Google for exactly `id,photos`
 * and nothing billed beside it; the whole author credit survives (the adapter
 * used to keep the name and drop the profile link and avatar); every link a
 * client will open or load is `https` on a Google host; and the image read
 * after a media call is an untrusted URL — checked, fetched with no key and no
 * redirects, bounded in type and size.
 */

const PLACE = 'ChIJ-lacaph';
const PHOTO = `places/${PLACE}/photos/AeJbb3c`;

const googlePhotos = {
  id: PLACE,
  photos: [
    {
      name: PHOTO,
      widthPx: 4032,
      heightPx: 3024,
      // Google's real shape: scheme-relative links.
      authorAttributions: [
        {
          displayName: 'Minh Trần',
          uri: '//maps.google.com/maps/contrib/110000000000000000001',
          photoUri: '//lh3.googleusercontent.com/a-/ALV-avatar=s100-p-k-no-mo',
        },
        { displayName: '' },
      ],
      googleMapsUri: 'https://www.google.com/maps/place//data=!3m4!1e2!3m2!1sAeJbb3c',
    },
    // No credit at all — cannot be shown with its credit, so not shown.
    { name: `places/${PLACE}/photos/NoCredit`, authorAttributions: [] },
    // Names another place — never fetched under this one.
    {
      name: 'places/ChIJ-other/photos/X1',
      authorAttributions: [{ displayName: 'A' }],
    },
    // Not a name this adapter would ever put in a URL.
    { name: `places/${PLACE}/photos/../../x`, authorAttributions: [{ displayName: 'B' }] },
  ],
};

type Call = { url: string; init: { headers?: Record<string, string>; redirect?: string } };
let calls: Call[];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function imageResponse(bytes: number, contentType = 'image/jpeg') {
  return new Response(new Uint8Array(bytes).fill(7), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

beforeEach(() => {
  calls = [];
  resetBreakers();
});
afterEach(() => vi.unstubAllGlobals());

function stub(...responses: Response[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init: Call['init']) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error('unexpected fetch');
      return next;
    }),
  );
}

describe('photoRefs', () => {
  it('asks for exactly id,photos — the IDs-Only SKU, nothing billed beside it', async () => {
    stub(jsonResponse(googlePhotos));
    await new GooglePlacesAdapter('key').photoRefs(PLACE);
    expect(PHOTO_DISPLAY_FIELD_MASK).toBe('id,photos');
    expect(calls[0]!.init.headers!['X-Goog-FieldMask']).toBe('id,photos');
    expect(calls[0]!.url).toContain(`/v1/places/${PLACE}?`);
  });

  it('keeps the whole author credit, links normalised to https', async () => {
    stub(jsonResponse(googlePhotos));
    const refs = await new GooglePlacesAdapter('key').photoRefs(PLACE);
    expect(refs).toEqual({
      providerPlaceId: PLACE,
      photos: [
        {
          reference: PHOTO,
          widthPx: 4032,
          heightPx: 3024,
          authorAttributions: [
            {
              displayName: 'Minh Trần',
              uri: 'https://maps.google.com/maps/contrib/110000000000000000001',
              photoUri: 'https://lh3.googleusercontent.com/a-/ALV-avatar=s100-p-k-no-mo',
            },
          ],
          googleMapsUri: 'https://www.google.com/maps/place//data=!3m4!1e2!3m2!1sAeJbb3c',
        },
      ],
    });
  });

  it('reports the id Google answered with, so a caller can refuse a moved place', async () => {
    stub(jsonResponse({ id: 'ChIJ-successor', photos: [] }));
    const refs = await new GooglePlacesAdapter('key').photoRefs(PLACE);
    expect(refs?.providerPlaceId).toBe('ChIJ-successor');
  });

  it('labels the request with its own operation, not a Details tier', async () => {
    stub(jsonResponse(googlePhotos));
    const labels: Record<string, unknown>[] = [];
    await new GooglePlacesAdapter('key', {
      increment: (name, l) => void labels.push({ name, ...l }),
      observe: () => undefined,
    }).photoRefs(PLACE);
    expect(labels).toContainEqual(
      expect.objectContaining({
        name: 'places_provider_requests_total',
        method: 'google.details.photos',
      }),
    );
  });

  it("stops at the caller's deadline without calling Google or tripping the breaker", async () => {
    stub();
    const controller = new AbortController();
    controller.abort();
    const adapter = new GooglePlacesAdapter('key');
    for (let i = 0; i < 6; i++) {
      await expect(adapter.photoRefs(PLACE, { signal: controller.signal })).rejects.toBeInstanceOf(
        ProviderCallAbortedError,
      );
    }
    expect(calls).toHaveLength(0);
    // Six caller aborts later the breaker is still closed.
    stub(jsonResponse(googlePhotos));
    expect((await adapter.photoRefs(PLACE))?.photos).toHaveLength(1);
  });

  it('does not retry — a slow photo is simply not shown', async () => {
    stub(jsonResponse({ error: { status: 'UNAVAILABLE' } }, 503));
    await expect(new GooglePlacesAdapter('key').photoRefs(PLACE)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('toDisplayPhotos — link safety', () => {
  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>'],
    ['http://maps.google.com/maps/contrib/1'],
    ['https://evil.example/maps/contrib/1'],
    ['https://maps.google.com.evil.example/x'],
    ['https://user:pw@maps.google.com/x'],
    ['https://maps.google.com:8443/x'],
    ['not a url'],
  ])('drops an unsafe author link %s to null, keeping the credit', (uri) => {
    const [photo] = toDisplayPhotos(PLACE, [
      { name: PHOTO, authorAttributions: [{ displayName: 'Lan', uri, photoUri: uri }] },
    ]);
    expect(photo!.authorAttributions).toEqual([{ displayName: 'Lan', uri: null, photoUri: null }]);
  });

  it('accepts an avatar only from a Google image host', () => {
    expect(
      safeProviderUri('https://lh3.googleusercontent.com/a/x', ['googleusercontent.com']),
    ).toBe('https://lh3.googleusercontent.com/a/x');
    expect(safeProviderUri('https://maps.google.com/a/x', ['googleusercontent.com'])).toBeNull();
  });
});

describe('photoMedia', () => {
  const options = { maxWidthPx: 800, maxBytes: 1024 };
  const media = (photoUri: string) => jsonResponse({ name: `${PHOTO}/media`, photoUri });

  it('asks for the URL as JSON, then reads the image with no key and no redirects', async () => {
    stub(media('https://lh3.googleusercontent.com/p/AF1Q=w800'), imageResponse(512));
    const result = await new GooglePlacesAdapter('key').photoMedia(PHOTO, options);

    expect(calls[0]!.url).toBe(
      `https://places.googleapis.com/v1/${PHOTO}/media?maxWidthPx=800&skipHttpRedirect=true`,
    );
    expect(calls[0]!.init.headers).not.toHaveProperty('X-Goog-FieldMask');
    expect(calls[1]!.url).toBe('https://lh3.googleusercontent.com/p/AF1Q=w800');
    expect(calls[1]!.init.redirect).toBe('error');
    expect(JSON.stringify(calls[1]!.init)).not.toContain('key');
    expect(result?.contentType).toBe('image/jpeg');
    expect(result?.bytes.byteLength).toBe(512);
  });

  it('never fetches an image URL that is not a Google image host (SSRF)', async () => {
    for (const uri of [
      'http://lh3.googleusercontent.com/p/x',
      'https://169.254.169.254/latest/meta-data',
      'https://lh3.googleusercontent.com.evil.example/p/x',
      'https://maps.google.com/p/x',
    ]) {
      calls = [];
      stub(media(uri));
      expect(await new GooglePlacesAdapter('key').photoMedia(PHOTO, options)).toBeNull();
      expect(calls).toHaveLength(1);
    }
  });

  it('refuses a reference that is not a photo name, without calling Google', async () => {
    stub();
    expect(
      await new GooglePlacesAdapter('key').photoMedia('places/x/photos/../../v1/secret', options),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('drops an image over the byte ceiling', async () => {
    stub(media('https://lh3.googleusercontent.com/p/big'), imageResponse(2048));
    expect(await new GooglePlacesAdapter('key').photoMedia(PHOTO, options)).toBeNull();
  });

  it('drops a body that is not an allowed image type', async () => {
    stub(media('https://lh3.googleusercontent.com/p/x'), imageResponse(10, 'text/html'));
    expect(await new GooglePlacesAdapter('key').photoMedia(PHOTO, options)).toBeNull();
  });

  it('counts each media call as one google.photoMedia cost unit', async () => {
    stub(media('https://lh3.googleusercontent.com/p/x'), imageResponse(10));
    const labels: Record<string, unknown>[] = [];
    await new GooglePlacesAdapter('key', {
      increment: (name, l) => void labels.push({ name, ...l }),
      observe: () => undefined,
    }).photoMedia(PHOTO, options);
    expect(labels).toContainEqual(
      expect.objectContaining({ name: 'places_provider_cost_units', sku: 'google.photoMedia' }),
    );
  });
});
