import { describe, expect, it, vi } from 'vitest';
import { backfillPlaceAddresses, type AddressBackfillStore } from './place-address-backfill';

function fixture(addresses: (string | null)[] = [null, '', 'Admin address']) {
  const rows = addresses.map((address, i) => ({
    id: String(i + 1),
    externalId: `google-${i}`,
    address,
  }));
  const store: AddressBackfillStore = {
    scan: vi.fn(async (after, limit) =>
      rows.filter((r) => !r.address?.trim() && (after === null || r.id > after)).slice(0, limit),
    ),
    writeIfEmpty: vi.fn(async (place, address) => {
      const row = rows.find((r) => r.id === place.id)!;
      if (row.address?.trim()) return false;
      row.address = address;
      return true;
    }),
  };
  const provider = { address: vi.fn(async () => 'Google address') };
  return { rows, store, provider };
}
const execute = { dryRun: false, maxGoogleCalls: 100 };

describe('place address backfill', () => {
  it('fills only empty cells; leaves admin values intact; second run is a no-op', async () => {
    const f = fixture();
    expect(await backfillPlaceAddresses(f.store, f.provider, execute)).toMatchObject({
      scanned: 2,
      written: 2,
      skipped: 0,
      errors: 0,
      callSlots: 2,
    });
    expect(f.rows[2]!.address).toBe('Admin address');
    expect(await backfillPlaceAddresses(f.store, f.provider, execute)).toMatchObject({
      scanned: 0,
      written: 0,
    });
    expect(f.provider.address).toHaveBeenCalledTimes(2);
  });

  it('stops at the cap even after errors', async () => {
    const f = fixture([null, null, null]);
    f.provider.address.mockRejectedValueOnce(new Error('private provider body'));
    expect(
      await backfillPlaceAddresses(f.store, f.provider, { ...execute, maxGoogleCalls: 2 }),
    ).toMatchObject({ scanned: 2, written: 1, errors: 1, callSlots: 2 });
    expect(f.provider.address).toHaveBeenCalledTimes(2);
    expect(f.rows[0]!.address).toBeNull();
    expect(f.rows[2]!.address).toBeNull();
  });

  it('dry-run previews within the cap without provider calls or writes', async () => {
    const f = fixture();
    expect(
      await backfillPlaceAddresses(f.store, f.provider, { dryRun: true, maxGoogleCalls: 1 }),
    ).toEqual({ scanned: 1, written: 0, skipped: 1, errors: 0, callSlots: 0 });
    expect(f.provider.address).not.toHaveBeenCalled();
    expect(f.store.writeIfEmpty).not.toHaveBeenCalled();
  });

  it('skips missing addresses and a racing admin edit', async () => {
    const f = fixture([null, null]);
    f.provider.address
      .mockImplementationOnce(async () => {
        f.rows[0]!.address = 'Racing admin';
        return 'Google address';
      })
      .mockResolvedValueOnce('  ');
    expect(await backfillPlaceAddresses(f.store, f.provider, execute)).toMatchObject({
      written: 0,
      skipped: 2,
    });
    expect(f.rows[0]!.address).toBe('Racing admin');
  });

  it('counts a DB write error and continues', async () => {
    const f = fixture();
    vi.mocked(f.store.writeIfEmpty).mockRejectedValueOnce(new Error('private database body'));
    expect(await backfillPlaceAddresses(f.store, f.provider, execute)).toMatchObject({
      written: 1,
      errors: 1,
    });
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid cap %s before scanning', async (cap) => {
    const f = fixture();
    await expect(
      backfillPlaceAddresses(f.store, f.provider, { ...execute, maxGoogleCalls: cap }),
    ).rejects.toThrow();
    expect(f.store.scan).not.toHaveBeenCalled();
  });
});
