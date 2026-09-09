import { describe, expect, it } from 'vitest';
import { cidFromGoogleMapsUri, parseFeatureId, parseMapsUrl } from './maps-url';
import { decideMatch, nameCoverage, type MatchTarget } from './match-score';

/**
 * GoGo-BE#505 — the share links people actually send.
 *
 * Every URL below is a real one, captured by expanding a real
 * `maps.app.goo.gl` link, and every Google fact asserted against it (display
 * name, CID, coordinate) was read from a live Places API response on
 * 2026-09-09. The point of the file is that the two clients produce **two
 * different URL shapes for the same place**, and that resolution has to work
 * on both without being told which one it is looking at.
 *
 * The application writes `?q=<name>, <full postal address>&ftid=0x…:0x…`.
 * The browser writes `/maps/place/<Name>/@<viewport>/data=…!1s0x…:0x…!8m2!3d<lat>!4d<lng>`.
 */

/** Bảo tàng Hà Nội — shared from the Google Maps application on a phone. */
const APP_LINK =
  'https://maps.google.com?q=B%E1%BA%A3o+t%C3%A0ng+H%C3%A0+N%E1%BB%99i,+%C4%90%C6%B0%E1%BB%9Dng+Ph%E1%BA%A1m+H%C3%B9ng,+T%E1%BB%AB+Li%C3%AAm,+H%C3%A0+N%E1%BB%99i+100000,+Vi%E1%BB%87t+Nam' +
  '&ftid=0x3135acabcbd609c7:0x6b1fec17e2d8f44b&entry=gps&g_st=ic';

/** Sheraton Hanoi West — the Share button in a desktop browser. */
const BROWSER_LINK =
  'https://www.google.com/maps/place/Sheraton+Hanoi+West/@21.0271386,105.7570553,15z/' +
  'data=!4m9!3m8!1s0x313455c3ab6d46a7:0x974b8adb8575af98!5m2!4m1!1i2!8m2!3d21.0271403!4d105.767351' +
  '!16s%2Fg%2F11fmxnmm12?entry=tts';

/** Cafe Phê La — a browser link to one branch of a chain with many. */
const BRANCH_LINK =
  'https://www.google.com/maps/place/Cafe+Ph%C3%AA+La/@21.0533053,105.8159618,16.18z/' +
  'data=!4m6!3m5!1s0x3135ab85ff36dd35:0x452419e97d6868e3!8m2!3d21.0495428!4d105.8138058' +
  '!16s%2Fg%2F11gjhnc743';

describe('#505 — what a share link actually carries', () => {
  it('reads the application shape: name+address query, ftid, no coordinate', () => {
    const r = parseMapsUrl(APP_LINK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.query).toBe(
      'Bảo tàng Hà Nội, Đường Phạm Hùng, Từ Liêm, Hà Nội 100000, Việt Nam',
    );
    // The identity Google put in the link, and the only one it carries.
    expect(r.value.featureId?.cid).toBe('7719147873670591563');
    expect(r.value.providerPlaceId).toBeUndefined();
    // An application link states no position at all — neither kind.
    expect(r.value.placeLat).toBeUndefined();
    expect(r.value.viewportLat).toBeUndefined();
  });

  it('reads the browser shape and keeps place and viewport apart', () => {
    const r = parseMapsUrl(BROWSER_LINK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.query).toBe('Sheraton Hanoi West');
    expect(r.value.featureId?.cid).toBe('10901959998421970840');
    // `!8m2!3d…!4d…` — where the hotel is.
    expect(r.value.placeLat).toBeCloseTo(21.0271403, 6);
    expect(r.value.placeLng).toBeCloseTo(105.767351, 6);
    // `@…` — where the map was centred, 1.07 km west of it.
    expect(r.value.viewportLat).toBeCloseTo(21.0271386, 6);
    expect(r.value.viewportLng).toBeCloseTo(105.7570553, 6);
    expect(r.value.placeLng).not.toBeCloseTo(r.value.viewportLng!, 3);
  });

  it('both clients name the same place identically when they name the same place', () => {
    // The identity in a browser link's `data=!1s…` and in an application
    // link's `ftid=` are the same field in the same format. Reading one and
    // not the other is what made the two clients behave differently.
    const fromData = parseMapsUrl(BROWSER_LINK);
    const fromParam = parseMapsUrl(
      'https://maps.google.com/?q=Sheraton&ftid=0x313455c3ab6d46a7:0x974b8adb8575af98',
    );
    expect(fromData.ok && fromData.value.featureId).toEqual(
      fromParam.ok ? fromParam.value.featureId : null,
    );
  });

  it('keeps a CID exact — it does not fit in a double', () => {
    const parsed = parseFeatureId('0x313455c3ab6d46a7:0x974b8adb8575af98');
    expect(parsed?.cid).toBe('10901959998421970840');
    // What `Number` would have made of it, and why the value is a string.
    expect(Number(parsed!.cid)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(String(Number(parsed!.cid))).not.toBe(parsed!.cid);
  });

  it('matches the CID Google publishes in googleMapsUri', () => {
    // Read from the live API on 2026-09-09 for ChIJp0Ztq8NVNDERmK91hduKS5c.
    const uri = 'https://maps.google.com/?cid=10901959998421970840&g_mp=CiVnb29nbGU';
    expect(cidFromGoogleMapsUri(uri)).toBe(parseFeatureId('0x0:0x974b8adb8575af98')!.cid);
    expect(cidFromGoogleMapsUri('https://maps.google.com/?q=x')).toBeNull();
    expect(cidFromGoogleMapsUri(null)).toBeNull();
    expect(cidFromGoogleMapsUri('not a url')).toBeNull();
  });

  it('refuses a feature id that is not one, rather than half-reading it', () => {
    expect(parseFeatureId('0x123')).toBeNull();
    expect(parseFeatureId('deadbeef:0x1')).toBeNull();
    expect(parseFeatureId('0xzz:0x1')).toBeNull();
    // 17 hex digits is not a 64-bit id.
    expect(parseFeatureId('0x1:0x123456789abcdef01')).toBeNull();
  });

  it('reads `?q=place_id:…` as an identifier, not as text to search for', () => {
    const r = parseMapsUrl('https://maps.google.com/?q=place_id:ChIJp0Ztq8NVNDERmK91hduKS5c');
    expect(r.ok && r.value.providerPlaceId).toBe('ChIJp0Ztq8NVNDERmK91hduKS5c');
    expect(r.ok && r.value.query).toBeUndefined();
  });

  it('reads a chain branch link: name, exact point, and the branch CID', () => {
    const r = parseMapsUrl(BRANCH_LINK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.query).toBe('Cafe Phê La');
    expect(r.value.placeLat).toBeCloseTo(21.0495428, 6);
    expect(r.value.placeLng).toBeCloseTo(105.8138058, 6);
    // 430 m from the `@` the same link carries — which branch that is matters.
    expect(r.value.viewportLat).toBeCloseTo(21.0533053, 6);
    expect(r.value.featureId?.cid).toBe('4982135578400680163');
  });

  it('a typed coordinate is where the place is; a viewport still is not', () => {
    const typed = parseMapsUrl('https://maps.google.com/?q=21.0271403,105.767351');
    expect(typed.ok && typed.value.placeLat).toBeCloseTo(21.0271403, 6);
    const viewportOnly = parseMapsUrl('https://www.google.com/maps/@21.03,105.85,15z');
    expect(viewportOnly.ok && viewportOnly.value.placeLat).toBeUndefined();
    expect(viewportOnly.ok && viewportOnly.value.viewportLat).toBeCloseTo(21.03, 6);
  });

  it('does not mistake a directions waypoint for the place', () => {
    // `!3d`/`!4d` pair up in several `data` sections; only `!8m2` introduces
    // the place this link is about.
    const r = parseMapsUrl(
      'https://www.google.com/maps/dir/A/B/data=!4m2!4m1!3e0!5m2!3d21.5!4d105.5',
    );
    expect(r.ok && r.value.placeLat).toBeUndefined();
  });
});

describe('#505 — punctuation must not cost name coverage', () => {
  it('a name followed by its address covers as well as the name alone', () => {
    const name = 'Sheraton Hanoi West';
    const withAddress = 'Sheraton Hanoi West, 36 Lê Đức Thọ, Từ Liêm, Hà Nội, Việt Nam';
    expect(nameCoverage(name, name)).toBe(1);
    // Before #505 this was 0.667 — `west,` is not `west` — and 0.667 is under
    // the 0.70 confirm floor, so the application's own link failed on a comma.
    expect(nameCoverage(withAddress, name)).toBe(1);
  });

  it('normalises the candidate side too, and stays accent-insensitive', () => {
    expect(nameCoverage('Bao tang Ha Noi, Pham Hung', 'Bảo tàng Hà Nội')).toBe(1);
    expect(nameCoverage('Lacàph Coffee Bar', 'Lacaph Coffee Bar 🇻🇳☕️')).toBe(1);
  });

  it('does not merge different branches of the same brand', () => {
    // Dropping punctuation must not drop words: two branches still differ.
    const query = 'Phê La, Đường Xuân Diệu, Tây Hồ, Hà Nội';
    expect(nameCoverage(query, 'Phê La - Xuân Diệu')).toBe(1);
    expect(nameCoverage(query, 'Phê La - Núi Trúc')).toBeLessThan(0.7);
    expect(nameCoverage(query, 'Phê La - Huỳnh Thúc Kháng')).toBeLessThan(0.7);
  });
});

const target = (over: Partial<MatchTarget> & Pick<MatchTarget, 'googlePlaceId'>): MatchTarget => ({
  name: 'Phê La',
  address: 'Hà Nội',
  lat: 21.05,
  lng: 105.81,
  ...over,
});

describe('#505 — CID decides identity, scoring does not have to', () => {
  const CID = '4982135578400680163';

  it('resolves the branch the link names even when its name scores badly', () => {
    const decision = decideMatch(
      { query: 'Cafe Phê La', featureCid: CID, lat: 21.0495428, lng: 105.8138058 },
      [
        target({ googlePlaceId: 'ChIJ-nui-truc', name: 'Phê La - Núi Trúc', providerCid: '1' }),
        target({
          googlePlaceId: 'ChIJ-xuan-dieu',
          name: 'Phê La - Xuân Diệu',
          lat: 21.0495428,
          lng: 105.8138058,
          providerCid: CID,
        }),
      ],
    );
    expect(decision.outcome).toBe('RESOLVED_AUTOMATICALLY');
    expect(decision.best?.target.googlePlaceId).toBe('ChIJ-xuan-dieu');
    expect(decision.reasons).toContain('CID_EXACT_MATCH');
    // The scored list is kept, so the disagreement is visible rather than hidden.
    expect(decision.candidates).toHaveLength(2);
  });

  it('says so when identity and the text score disagree', () => {
    const decision = decideMatch({ query: 'Phê La', featureCid: CID }, [
      target({ googlePlaceId: 'ChIJ-brand', name: 'Phê La', providerCid: '99' }),
      target({ googlePlaceId: 'ChIJ-branch', name: 'Phê La - Núi Trúc', providerCid: CID }),
    ]);
    expect(decision.best?.target.googlePlaceId).toBe('ChIJ-branch');
    expect(decision.reasons).toContain('CID_OVERRODE_SCORE');
  });

  it('falls back to normal scoring when no candidate carries the CID', () => {
    const decision = decideMatch({ query: 'Phê La', featureCid: CID }, [
      target({ googlePlaceId: 'ChIJ-a', name: 'Phê La - Núi Trúc', providerCid: '1' }),
      target({ googlePlaceId: 'ChIJ-b', name: 'Phê La - Ngọc Hà', providerCid: null }),
    ]);
    // Two branches, neither identified: still a question for a person.
    expect(decision.outcome).not.toBe('RESOLVED_AUTOMATICALLY');
    expect(decision.reasons).toContain('MULTIPLE_BRANCHES');
  });

  it('never lets a CID mismatch pass as a match', () => {
    const decision = decideMatch({ query: 'Phê La', featureCid: CID }, [
      target({ googlePlaceId: 'ChIJ-a', name: 'Phê La', providerCid: '1' }),
    ]);
    expect(decision.best?.reasons).not.toContain('CID_EXACT_MATCH');
  });

  it('leaves the thresholds where they are', () => {
    // The fix must not be "let weaker matches through". A single candidate
    // whose name half-covers the query and carries no CID is still refused.
    const decision = decideMatch({ query: 'Phê La Xuân Diệu Tây Hồ' }, [
      target({ googlePlaceId: 'ChIJ-x', name: 'Cộng Cà Phê Tây Hồ' }),
    ]);
    expect(decision.outcome).toBe('UNRESOLVED');
    expect(decision.best!.confidence).toBeLessThan(0.7);
  });
});
