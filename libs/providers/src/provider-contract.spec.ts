import { describe, expect, it } from 'vitest';
import { FakePlaceProvider, FakeSheets } from './fake.adapters';
import { GooglePlacesAdapter } from './google-places.adapter';
import { GoogleSheetsAdapter } from './google-sheets.adapter';
import {
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  SheetAccessError,
  type PlaceProviderPort,
  type SheetsPort,
} from './ports';

/**
 * PI-QA-001 — contract tests for the provider ports.
 *
 * CI never talks to Google: these assert that the fakes implement the same
 * contract the real adapters do, including the two failure modes callers treat
 * differently (quota parks a bulk job; a timeout is just an unresolved row).
 */

describe('PlaceProviderPort contract', () => {
  const shapeOf = (adapter: PlaceProviderPort) =>
    ['resolveUrl', 'details'].every((m) => typeof (adapter as never)[m] === 'function');

  it('fake and real adapter expose the same surface', () => {
    expect(shapeOf(new FakePlaceProvider())).toBe(true);
    expect(shapeOf(new GooglePlacesAdapter('unused-in-this-test'))).toBe(true);
  });

  it('resolves a seeded place and returns null for an unknown one', async () => {
    const provider = new FakePlaceProvider();
    provider.seed({ providerPlaceId: 'fake-1', name: 'Quán A' });

    const id = await provider.resolveUrl('https://www.google.com/maps?place_id=fake-1');
    expect(id).toBe('fake-1');
    const details = await provider.details('fake-1', 'quality');
    expect(details?.name).toBe('Quán A');
    expect(details?.businessStatus).toBe('OPERATIONAL');
    expect(await provider.details('missing', 'quality')).toBeNull();
    expect(await provider.resolveUrl('https://www.google.com/maps/place/No+Id')).toBeNull();
  });

  it('the fake narrows a liveness answer exactly as the adapter does', async () => {
    const provider = new FakePlaceProvider();
    provider.seed({ providerPlaceId: 'fake-1', name: 'Quán A' });

    // #338 — the point of the tier is what it *cannot* answer. A fake that
    // handed back a whole place here would let an integration test prove a
    // refresh job works on facts the free SKU never returns.
    expect(await provider.details('fake-1', 'liveness')).toEqual({
      providerPlaceId: 'fake-1',
      fetchTier: 'liveness',
    });

    provider.movedTo.set('fake-old', 'fake-1');
    expect(await provider.details('fake-old', 'liveness')).toEqual({
      providerPlaceId: 'fake-1',
      requestedProviderPlaceId: 'fake-old',
      fetchTier: 'liveness',
    });

    expect(await provider.details('missing', 'liveness')).toBeNull();
  });

  it('signals quota separately from an outage', async () => {
    const provider = new FakePlaceProvider();
    provider.seed({ providerPlaceId: 'fake-1' });

    provider.quotaExhausted = true;
    await expect(provider.details('fake-1', 'quality')).rejects.toBeInstanceOf(
      ProviderQuotaExceededError,
    );
    await expect(
      provider.resolveUrl('https://maps.google.com/?place_id=fake-1'),
    ).rejects.toBeInstanceOf(ProviderQuotaExceededError);

    provider.quotaExhausted = false;
    provider.timingOut = true;
    await expect(provider.details('fake-1', 'quality')).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );

    provider.timingOut = false;
    provider.failing = true;
    await expect(provider.details('fake-1', 'quality')).rejects.toThrow('fake provider down');
  });
});

describe('SheetsPort contract', () => {
  const shapeOf = (adapter: SheetsPort) =>
    ['listTabs', 'readTab'].every((m) => typeof (adapter as never)[m] === 'function');

  it('fake and real adapter expose the same surface', () => {
    expect(shapeOf(new FakeSheets())).toBe(true);
    expect(shapeOf(new GoogleSheetsAdapter('unused-in-this-test'))).toBe(true);
  });

  it('lists tabs, bounds the read and maps access failures to codes', async () => {
    const sheets = new FakeSheets();
    sheets.seed('book-1', 'HCM', [
      ['name', 'city'],
      ['A', 'HCM'],
      ['B', 'HCM'],
      ['C', 'HCM'],
    ]);

    expect((await sheets.listTabs('book-1')).map((t) => t.title)).toEqual(['HCM']);
    // maxRows counts data rows; the header is extra.
    expect(await sheets.readTab('book-1', 'HCM', 2)).toHaveLength(3);

    await expect(sheets.readTab('book-1', 'HN', 10)).rejects.toMatchObject({
      code: 'SHEET_TAB_NOT_FOUND',
    });
    // PI-BE-021: an unseeded id means this fake cannot reach Google at all —
    // it is not a claim that the spreadsheet is missing.
    await expect(sheets.listTabs('nope')).rejects.toMatchObject({
      code: 'SHEET_PROVIDER_NOT_CONFIGURED',
    });

    sheets.denied.add('book-1');
    await expect(sheets.listTabs('book-1')).rejects.toBeInstanceOf(SheetAccessError);

    sheets.denied.clear();
    sheets.quotaExhausted = true;
    await expect(sheets.listTabs('book-1')).rejects.toBeInstanceOf(ProviderQuotaExceededError);
  });
});
