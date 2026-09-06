import { describe, expect, it } from 'vitest';
import { FakeAcquisitionLinkProvider, NoAcquisitionLinkProvider } from '@gogo/providers';
import { ShareLinksService } from './share-links.service';

/**
 * LNK-BE-003 (#206) — the vendor never decides whether a link exists.
 * Stubs stand in for the repository and room services: this is about what the
 * service stores when attribution succeeds, is absent, or fails.
 */

const user = { type: 'user', id: 'a3f1c2d4-0000-4000-8000-000000000001', sessionId: 's' } as const;
const PLACE = '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';

function build(acquisition: FakeAcquisitionLinkProvider | NoAcquisitionLinkProvider) {
  const inserted: Record<string, unknown>[] = [];
  const repo = {
    insert: async (input: Record<string, unknown>) => {
      inserted.push(input);
      return { id: 'link-1', ...input };
    },
    placeIsPublished: async () => true,
  };
  const tokens = { hashOpaqueToken: (v: string) => `hash(${v})` };
  const service = new ShareLinksService(
    repo as never,
    {} as never,
    {} as never,
    tokens as never,
    { SHARE_LINK_BASE_URL: 'https://go-test.gogo.id.vn' },
    undefined,
    acquisition,
  );
  return { service, inserted };
}

describe('ShareLinksService attribution (#206)', () => {
  it('attaches the vendor URL with the canonical link as deferred target', async () => {
    const vendor = new FakeAcquisitionLinkProvider();
    const { service, inserted } = build(vendor);
    const created = await service.create(user, {
      type: 'PLACE',
      entityId: PLACE,
      campaign: 'zalo',
    });
    expect(vendor.requests).toEqual([{ canonicalUrl: created.url, campaign: 'zalo' }]);
    expect(inserted[0]).toMatchObject({
      provider: 'TENJIN',
      providerTrackingUrl: `https://track.fake.test/click?deeplink_url=${encodeURIComponent(created.url)}`,
      campaign: 'zalo',
    });
    // The slug is stored hashed; the plaintext is only in the returned URL.
    expect(inserted[0]!.slugHash).toMatch(/^hash\(/);
    expect(created.url).not.toContain(String(inserted[0]!.slugHash));
  });

  it('a vendor failure leaves the link minted without attribution (FR-LINK-006)', async () => {
    const vendor = new FakeAcquisitionLinkProvider();
    vendor.failing = true;
    const { service, inserted } = build(vendor);
    const created = await service.create(user, { type: 'PLACE', entityId: PLACE });
    expect(created.url).toMatch(/^https:\/\/go-test\.gogo\.id\.vn\/l\/[A-Za-z0-9_-]{22}$/);
    expect(inserted[0]).toMatchObject({ provider: 'NONE', providerTrackingUrl: null });
  });

  it('no vendor configured is a plain NONE, not an error', async () => {
    const { service, inserted } = build(new NoAcquisitionLinkProvider());
    await service.create(user, { type: 'PLACE', entityId: PLACE });
    expect(inserted[0]).toMatchObject({ provider: 'NONE', providerTrackingUrl: null });
  });
});
