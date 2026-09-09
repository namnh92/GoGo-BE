import { describe, expect, it, beforeEach } from 'vitest';
import { FakePlaceProvider } from '@gogo/providers';
import { type Db } from '@gogo/database';
import { PlaceResolverService } from './place-resolver.service';

/**
 * #311 — Mobile add-by-link, end to end through the resolver.
 *
 * On 2026-09-01, with Google answering correctly on DEV, a `?api=1&query=…`
 * link for a real café came back `UNRESOLVED / LOW_CONFIDENCE`: the free-text
 * query was scored as if it were the place's name, and only the first provider
 * hit was ever considered. These cases pin both halves.
 *
 * `resolveFromUrl` never touches the database, so the stub below is enough.
 */
describe('resolveFromUrl on a shared link (PI-BE-025)', () => {
  let provider: FakePlaceProvider;
  let resolver: PlaceResolverService;

  beforeEach(() => {
    provider = new FakePlaceProvider();
    resolver = new PlaceResolverService(provider, {} as Db);
    provider.seed({
      providerPlaceId: 'ChIJ-lacaph-space',
      name: 'Lacàph Coffee Experiences Space 🇻🇳☕️',
      addressText: 'Tầng 1, 220 Nguyễn Công Trứ, Bến Thành, Hồ Chí Minh, Vietnam',
      lat: 10.7679,
      lng: 106.7004,
    });
    provider.seed({
      providerPlaceId: 'ChIJ-lacaph-bar',
      name: 'Lacàph Coffee Bar 🇻🇳☕️',
      addressText: 'Lầu 1, 151 Đồng Khởi, Sài Gòn, Hồ Chí Minh, Vietnam',
      lat: 10.7776,
      lng: 106.703,
    });
  });

  const link = (q: string, extra = '') =>
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}${extra}`;

  it('resolves the branch the link names, keeping the other on the decision', async () => {
    const out = await resolver.resolveFromUrl(
      link('Lacaph Coffee Experiences Space Ho Chi Minh City'),
      'quality',
    );

    // #311's guarantee holds: never UNRESOLVED for a link Google answered, and
    // the alternative stays on the decision. #473 lets it finish the job — the
    // query names this branch in full, and "Lacàph Coffee Bar" is a different
    // place rather than a branch wearing the same name.
    expect(out.status).toBe('RESOLVED');
    if (out.status !== 'RESOLVED') return;
    expect(out.decision.candidates).toHaveLength(2);
    expect(out.decision.best?.target.googlePlaceId).toBe('ChIJ-lacaph-space');
  });

  it('takes query_place_id as authoritative and skips the search', async () => {
    const out = await resolver.resolveFromUrl(
      link('Lacaph Coffee', '&query_place_id=ChIJ-lacaph-bar'),
      'quality',
    );

    expect(out.status).toBe('RESOLVED');
    if (out.status !== 'RESOLVED') return;
    // The id in the URL wins even though the query ranks the other branch first.
    expect(out.details.providerPlaceId).toBe('ChIJ-lacaph-bar');
    expect(out.decision.reasons).toContain('EXACT_PROVIDER_ID');
  });

  it('a query naming nothing in the catalogue is NOT_FOUND, not a bad match', async () => {
    const out = await resolver.resolveFromUrl(
      link('Trung Nguyen Legend Ho Chi Minh City'),
      'quality',
    );

    expect(out.status).toBe('UNRESOLVED');
    if (out.status !== 'UNRESOLVED') return;
    expect(out.reasonCode).toBe('NOT_FOUND');
  });

  it('scores at most CANDIDATE_LIMIT hits, however many the provider returns', async () => {
    for (let i = 0; i < 6; i += 1) {
      provider.seed({ providerPlaceId: `ChIJ-lacaph-${i}`, name: `Lacàph Branch ${i}` });
    }

    const out = await resolver.resolveFromUrl(link('Lacaph'), 'quality');

    if (out.status === 'UNRESOLVED') {
      expect(out.decision?.candidates.length ?? 0).toBeLessThanOrEqual(3);
      return;
    }
    if (out.status === 'NEEDS_CONFIRMATION') {
      expect(out.decision.candidates.length).toBeLessThanOrEqual(3);
    }
  });

  it('a URL with no query at all is NO_QUERY', async () => {
    const out = await resolver.resolveFromUrl('https://www.google.com/maps', 'quality');

    expect(out.status).toBe('UNRESOLVED');
    if (out.status !== 'UNRESOLVED') return;
    expect(out.reasonCode).toBe('NO_QUERY');
  });

  it('a provider outage is an unresolved link, not a crash', async () => {
    provider.failing = true;

    const out = await resolver.resolveFromUrl(link('Lacaph Coffee Experiences Space'), 'quality');

    expect(out.status).toBe('UNRESOLVED');
  });
});

/**
 * GoGo-BE#505 — the two real share-link shapes, end to end through the
 * resolver with a fake provider standing in for Google.
 *
 * The seeded rows below reproduce what the live Places API returned on
 * 2026-09-09: Vietnamese display names (the adapter now asks for them), the
 * CID inside `googleMapsUri`, and a chain whose branches sit within a few
 * hundred metres of each other.
 */
describe('share links from the application and the browser (#505)', () => {
  const MUSEUM_ID = 'ChIJxwnWy6usNTERS_TY4hfsH2s';
  const MUSEUM_CID = '7719147873670591563';
  const BRANCH_CID = '4982135578400680163';

  let provider: FakePlaceProvider;
  let resolver: PlaceResolverService;

  beforeEach(() => {
    provider = new FakePlaceProvider();
    resolver = new PlaceResolverService(provider, {} as Db);
    provider.seed({
      providerPlaceId: MUSEUM_ID,
      name: 'Bảo tàng Hà Nội',
      addressText: 'Đường Phạm Hùng, Từ Liêm, Hà Nội 100000',
      lat: 21.0055,
      lng: 105.7823,
      googleMapsUri: `https://maps.google.com/?cid=${MUSEUM_CID}&g_mp=X`,
    });
  });

  const seedBranches = () => {
    // Nearest to the link's `!8m2!3d…!4d…` point, and the one it means.
    provider.seed({
      providerPlaceId: 'ChIJNd02_4WrNTER42hofekZJEU',
      name: 'Cafe Phê La',
      addressText: '24 Lý Quốc Sư, Hoàn Kiếm, Hà Nội',
      lat: 21.0495428,
      lng: 105.8138058,
      googleMapsUri: `https://maps.google.com/?cid=${BRANCH_CID}`,
    });
    provider.seed({
      providerPlaceId: 'ChIJU_M8YACrNTERE1HwcYs9q7I',
      name: 'Phê La Thành Thái',
      addressText: 'Thành Thái, Cầu Giấy, Hà Nội',
      lat: 21.0301,
      lng: 105.7906,
      googleMapsUri: 'https://maps.google.com/?cid=12874451628890018067',
    });
    provider.seed({
      providerPlaceId: 'ChIJc8yFehitNTERfdmif1WxmFU',
      name: 'Phê La - Lê Văn Lương',
      addressText: 'Lê Văn Lương, Thanh Xuân, Hà Nội',
      lat: 21.0072,
      lng: 105.8046,
      googleMapsUri: 'https://maps.google.com/?cid=6167874670455609725',
    });
  };

  it('resolves an application link whose q is a full postal address', async () => {
    const out = await resolver.resolveFromUrl(
      'https://maps.google.com?q=B%E1%BA%A3o+t%C3%A0ng+H%C3%A0+N%E1%BB%99i,+%C4%90%C6%B0%E1%BB%9Dng' +
        '+Ph%E1%BA%A1m+H%C3%B9ng,+T%E1%BB%AB+Li%C3%AAm,+H%C3%A0+N%E1%BB%99i+100000,+Vi%E1%BB%87t+Nam' +
        '&ftid=0x3135acabcbd609c7:0x6b1fec17e2d8f44b&entry=gps',
      'quality',
    );

    expect(out.status).toBe('RESOLVED');
    if (out.status !== 'RESOLVED') return;
    expect(out.details.providerPlaceId).toBe(MUSEUM_ID);
    expect(out.decision.reasons).toContain('CID_EXACT_MATCH');
  });

  it('resolves the browser link for the same place', async () => {
    const out = await resolver.resolveFromUrl(
      'https://www.google.com/maps/place/B%E1%BA%A3o+t%C3%A0ng+H%C3%A0+N%E1%BB%99i/' +
        '@21.0055,105.7823,15z/data=!4m6!3m5!1s0x3135acabcbd609c7:0x6b1fec17e2d8f44b' +
        '!8m2!3d21.0055!4d105.7823!16s%2Fg%2Fx',
      'quality',
    );

    expect(out.status).toBe('RESOLVED');
    if (out.status !== 'RESOLVED') return;
    expect(out.details.providerPlaceId).toBe(MUSEUM_ID);
  });

  it('biases the search to the place coordinate, not the viewport', async () => {
    seedBranches();
    const out = await resolver.resolveFromUrl(
      'https://www.google.com/maps/place/Cafe+Ph%C3%AA+La/@21.0533053,105.8159618,16.18z/' +
        'data=!4m6!3m5!1s0x3135ab85ff36dd35:0x452419e97d6868e3!8m2!3d21.0495428!4d105.8138058',
      'quality',
    );

    // The bias Google was asked for is the `!8m2` point, tight; never the `@`.
    // The link carries a CID, so the one search made is the paid identity
    // search — and there is exactly one of it.
    expect(provider.searches).toHaveLength(0);
    expect(provider.identitySearches).toHaveLength(1);
    expect(provider.identitySearches[0]!.bias).toEqual({
      lat: 21.0495428,
      lng: 105.8138058,
      radiusMeters: 250,
    });
    expect(out.status).toBe('RESOLVED');
    if (out.status !== 'RESOLVED') return;
    expect(out.details.providerPlaceId).toBe('ChIJNd02_4WrNTER42hofekZJEU');
    expect(out.decision.reasons).toContain('CID_EXACT_MATCH');
  });

  it('uses the viewport only as a wide bias when nothing better is stated', async () => {
    await resolver.resolveFromUrl(
      'https://www.google.com/maps/place/B%E1%BA%A3o+t%C3%A0ng+H%C3%A0+N%E1%BB%99i/@21.03,105.85,15z',
      'quality',
    );
    expect(provider.searches[0]!.bias).toEqual({ lat: 21.03, lng: 105.85, radiusMeters: 5000 });
  });

  it('never scores the viewport as the place — Sheraton is 1.07 km from its own', async () => {
    provider.seed({
      providerPlaceId: 'ChIJp0Ztq8NVNDERmK91hduKS5c',
      name: 'Sheraton Hanoi West',
      addressText: '36 Le Duc Tho Street Tu Liem Ward, Từ Liêm, Hà Nội',
      lat: 21.0271403,
      lng: 105.767351,
      googleMapsUri: 'https://maps.google.com/?cid=10901959998421970840',
    });

    const out = await resolver.resolveFromUrl(
      'https://www.google.com/maps/place/Sheraton+Hanoi+West/@21.0271386,105.7570553,15z/' +
        'data=!4m9!3m8!1s0x313455c3ab6d46a7:0x974b8adb8575af98!5m2!4m1!1i2' +
        '!8m2!3d21.0271403!4d105.767351!16s%2Fg%2F11fmxnmm12',
      'quality',
    );

    expect(out.status).toBe('RESOLVED');
    if (out.status !== 'RESOLVED') return;
    // Scored against the place coordinate the link states, the distance is 0.
    // Against the viewport it would have been 1.07 km, worth 0.2 of a
    // dimension the URL never claimed.
    expect(out.decision.best?.confidence).toBe(1);
  });

  it('refuses a link that names one place by id and another by ftid', async () => {
    const out = await resolver.resolveFromUrl(
      `https://maps.google.com/?q=x&place_id=${MUSEUM_ID}` + '&ftid=0x1:0x452419e97d6868e3',
      'quality',
    );

    expect(out.status).toBe('UNRESOLVED');
    if (out.status !== 'UNRESOLVED') return;
    expect(out.reasonCode).toBe('LINK_IDENTITY_CONFLICT');
  });

  it('a place id with an ftid that agrees resolves as it always did', async () => {
    const out = await resolver.resolveFromUrl(
      `https://maps.google.com/?q=x&place_id=${MUSEUM_ID}` +
        '&ftid=0x3135acabcbd609c7:0x6b1fec17e2d8f44b',
      'quality',
    );
    expect(out.status).toBe('RESOLVED');
    if (out.status !== 'RESOLVED') return;
    expect(out.decision.reasons).toContain('EXACT_PROVIDER_ID');
  });

  it('finds a place ranked below the scoring window, for one search and one Details', async () => {
    // The real case: `Bến Bạch Đằng` is Google's fifth hit for its own name,
    // behind a park, a pier and a water-bus stop within 300 m. Three
    // candidates cannot contain it, and buying ten Enterprise Details to look
    // is $200/1,000 — so the identity search reads ten `googleMapsUri`s in one
    // Pro request ($32) and only the winner is fetched ($20).
    const decoys = [
      ['ChIJ-cong-vien', 'Công viên Bến Bạch Đằng', '6991131790925347073'],
      ['ChIJ-ben-tau', 'Bến tàu Bạch Đằng', '8813553796661064786'],
      ['ChIJ-waterbus', 'Saigon Waterbus Bạch Đằng', '4852626611537157215'],
      ['ChIJ-ga-tau', 'Ga Tàu Thuỷ Bạch Đằng', '9973775818134137011'],
    ] as const;
    decoys.forEach(([id, name, cid], index) => {
      provider.seed({
        providerPlaceId: id,
        name,
        lat: 10.7752 - index / 10_000,
        lng: 106.7071,
        googleMapsUri: `https://maps.google.com/?cid=${cid}`,
      });
    });
    provider.seed({
      providerPlaceId: 'ChIJ-ben-bach-dang',
      name: 'Bến Bạch Đằng',
      addressText: 'Tôn Đức Thắng, Bến Nghé, Hồ Chí Minh',
      // Farthest of the five, so nothing but the CID picks it out.
      lat: 10.7,
      lng: 106.7,
      googleMapsUri: 'https://maps.google.com/?cid=15871080084204990604',
    });

    const out = await resolver.resolveFromUrl(
      'https://www.google.com/maps/place/B%E1%BA%BFn+B%E1%BA%A1ch+%C4%90%E1%BA%B1ng/' +
        '@10.7768556,106.7079177,17.4z/data=!4m6!3m5!1s0x31752fd0bb720ac3:0xdc41673f7cd0b08c' +
        '!8m2!3d10.7755799!4d106.7071096!16s%2Fm%2F04cvvjr',
      'quality',
    );

    expect(out.status).toBe('RESOLVED');
    if (out.status !== 'RESOLVED') return;
    expect(out.details.providerPlaceId).toBe('ChIJ-ben-bach-dang');
    expect(out.decision.reasons).toContain('CID_EXACT_MATCH');
    // One paid search, no free one, and exactly one Details.
    expect(provider.identitySearches).toHaveLength(1);
    expect(provider.searches).toHaveLength(0);
    expect(provider.tiersRequested).toEqual(['quality']);
  });

  it('pays for the free search when the link states no identity', async () => {
    seedBranches();
    await resolver.resolveFromUrl(
      'https://www.google.com/maps/place/Ph%C3%AA+La/@21.03,105.80,15z',
      'quality',
    );
    // Nothing to compare a CID against, so nothing buys the Pro SKU.
    expect(provider.identitySearches).toHaveLength(0);
    expect(provider.searches).toHaveLength(1);
  });

  it('does not search twice when the identity search finds no match', async () => {
    provider.seed({
      providerPlaceId: 'ChIJ-other',
      name: 'Phê La Núi Trúc',
      googleMapsUri: 'https://maps.google.com/?cid=1',
    });

    const out = await resolver.resolveFromUrl(
      'https://www.google.com/maps/place/Ph%C3%AA+La/@21.03,105.80,15z/' +
        'data=!4m6!3m5!1s0x1:0x452419e97d6868e3!8m2!3d21.0495428!4d105.8138058',
      'quality',
    );

    // The ids the paid search returned are scored rather than fetched again.
    expect(provider.identitySearches).toHaveLength(1);
    expect(provider.searches).toHaveLength(0);
    expect(out.status).not.toBe('RESOLVED');
    if (out.status === 'UNRESOLVED' || out.status === 'NEEDS_CONFIRMATION') {
      expect(out.decision?.reasons).toContain('CID_NOT_IN_CANDIDATES');
    }
  });

  it('still asks a person when two branches are alike and none is identified', async () => {
    seedBranches();
    const out = await resolver.resolveFromUrl(
      'https://www.google.com/maps/place/Ph%C3%AA+La/@21.03,105.80,15z',
      'quality',
    );
    expect(out.status).not.toBe('RESOLVED');
  });
});
