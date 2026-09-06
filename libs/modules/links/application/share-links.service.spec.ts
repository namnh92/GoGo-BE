import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeAcquisitionLinkProvider, NoAcquisitionLinkProvider } from '@gogo/providers';
import { ShareLinksService } from './share-links.service';

/**
 * LNK-BE-003 (#206) — the vendor never decides whether a link exists, and
 * nothing it returns is stored. Stubs stand in for the repository and room
 * services: this is about what the service writes and what resolve composes.
 */

const user = { type: 'user', id: 'a3f1c2d4-0000-4000-8000-000000000001', sessionId: 's' } as const;
const PLACE = '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';
const ROOM = '7c1d2e3f-0000-4000-8000-000000000002';
const BASE = 'https://go-test.gogo.id.vn';

function build(acquisition: FakeAcquisitionLinkProvider | NoAcquisitionLinkProvider) {
  const inserted: Record<string, unknown>[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const repo = {
    insert: async (input: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        id: `link-${inserted.length + 1}`,
        inviteId: null,
        expiresAt: null,
        revokedAt: null,
        source: null,
        medium: null,
        campaign: null,
        ...input,
      };
      inserted.push(row);
      rows.set(String(row.slugHash), row);
      return row;
    },
    findBySlugHash: async (hash: string) => rows.get(hash),
    inviteUsable: async () => true,
    placeIsPublished: async () => true,
  };
  const rooms = {
    createInvite: async (
      _actor: unknown,
      _roomId: string,
      _max: unknown,
      options: { code: string },
    ) => ({
      inviteId: 'invite-1',
      code: options.code,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  };
  // The real hash, so "the row cannot recover the slug" is tested honestly.
  const tokens = {
    hashOpaqueToken: (v: string) => createHash('sha256').update(v).digest('hex'),
  };
  const service = new ShareLinksService(
    repo as never,
    rooms as never,
    {} as never,
    tokens as never,
    { SHARE_LINK_BASE_URL: BASE },
    undefined,
    acquisition,
  );
  return { service, inserted };
}

const slugOf = (url: string) => url.slice(`${BASE}/l/`.length);

describe('ShareLinksService attribution (#206)', () => {
  it('records the vendor, stores no URL, and composes the tracking URL on resolve', async () => {
    const vendor = new FakeAcquisitionLinkProvider();
    const { service, inserted } = build(vendor);
    const created = await service.create(user, {
      type: 'PLACE',
      entityId: PLACE,
      campaign: 'zalo',
    });
    expect(vendor.requests[0]).toEqual({ canonicalUrl: created.url, campaign: 'zalo' });
    expect(inserted[0]).toMatchObject({ provider: 'TENJIN', campaign: 'zalo' });
    expect(inserted[0]).not.toHaveProperty('providerTrackingUrl');

    const resolved = await service.resolve(slugOf(created.url));
    expect(resolved.provider).toBe('TENJIN');
    expect(resolved.trackingUrl).toBe(
      `https://track.fake.test/click?deeplink_url=${encodeURIComponent(created.url)}`,
    );
  });

  it('the stored row cannot recover the credential — review finding 1', async () => {
    const vendor = new FakeAcquisitionLinkProvider();
    const { service, inserted } = build(vendor);
    // ROOM_INVITE: the slug is the invite code, the one case that matters most.
    const created = await service.create(user, {
      type: 'ROOM_INVITE',
      entityId: ROOM,
      source: 'room_share',
    });
    const slug = slugOf(created.url);
    expect(slug).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Everything the repository was handed, serialised: no slug anywhere —
    // not in a hash column, not in a URL, not in a nested object.
    const stored = JSON.stringify(inserted);
    expect(stored).not.toContain(slug);
    expect(stored).not.toContain(encodeURIComponent(created.url));
    expect(stored).not.toContain('deeplink_url');
    // The vendor was still shown the canonical URL at mint time (that is the
    // attribution) — and it was not persisted.
    expect(vendor.requests[0]!.canonicalUrl).toBe(created.url);
    // Resolve hands the credential back only to the caller who presented it.
    const resolved = await service.resolve(slug);
    expect(resolved.target).toEqual({ inviteCode: slug });
    expect(resolved.trackingUrl).toContain(encodeURIComponent(created.url));
  });

  it('a vendor failure leaves the link minted without attribution (FR-LINK-006)', async () => {
    const vendor = new FakeAcquisitionLinkProvider();
    vendor.failing = true;
    const { service, inserted } = build(vendor);
    const created = await service.create(user, { type: 'PLACE', entityId: PLACE });
    expect(created.url).toMatch(/^https:\/\/go-test\.gogo\.id\.vn\/l\/[A-Za-z0-9_-]{22}$/);
    expect(inserted[0]).toMatchObject({ provider: 'NONE' });
    await expect(service.resolve(slugOf(created.url))).resolves.toMatchObject({
      provider: 'NONE',
      trackingUrl: null,
    });
  });

  it('a vendor that fails at resolve time degrades to the canonical link, not an error', async () => {
    const vendor = new FakeAcquisitionLinkProvider();
    const { service } = build(vendor);
    const created = await service.create(user, { type: 'PLACE', entityId: PLACE });
    vendor.failing = true;
    await expect(service.resolve(slugOf(created.url))).resolves.toMatchObject({
      type: 'PLACE',
      target: { placeId: PLACE },
      provider: 'NONE',
      trackingUrl: null,
    });
  });

  it('no vendor configured is a plain NONE, not an error', async () => {
    const { service, inserted } = build(new NoAcquisitionLinkProvider());
    const created = await service.create(user, { type: 'PLACE', entityId: PLACE });
    expect(inserted[0]).toMatchObject({ provider: 'NONE' });
    await expect(service.resolve(slugOf(created.url))).resolves.toMatchObject({
      trackingUrl: null,
    });
  });
});
