import { describe, expect, it } from 'vitest';
import { ProviderConfigurationError, ProviderInvalidRequestError } from './ports';
import {
  NoAcquisitionLinkProvider,
  TenjinAcquisitionLinkProvider,
} from './tenjin-acquisition-link.adapter';

const TEMPLATE = 'https://track.tenjin.com/v0/click/AbCdEf12?campaign_id=room_share';
const CANONICAL = 'https://go-dev.gogo.id.vn/l/Af82XcAf82XcAf82XcAf82';

describe('TenjinAcquisitionLinkProvider (#206)', () => {
  it('appends the canonical link as deeplink_url and keeps the template intact', async () => {
    const url = new URL(
      await new TenjinAcquisitionLinkProvider(TEMPLATE).createTrackingUrl({
        canonicalUrl: CANONICAL,
        campaign: 'room_share',
        source: 'zalo',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://track.tenjin.com/v0/click/AbCdEf12');
    expect(url.searchParams.get('campaign_id')).toBe('room_share');
    expect(url.searchParams.get('deeplink_url')).toBe(CANONICAL);
    // Nothing the vendor did not document, nothing personal.
    expect([...url.searchParams.keys()].sort()).toEqual(['campaign_id', 'deeplink_url']);
  });

  it('refuses a template that is not a bare https URL or that already fixes the target', () => {
    for (const bad of [
      'track.tenjin.com/v0/click/x',
      'http://track.tenjin.com/v0/click/x',
      'https://user:pw@track.tenjin.com/v0/click/x',
      'https://track.tenjin.com/v0/click/x?deeplink_url=https%3A%2F%2Fevil',
    ]) {
      expect(() => new TenjinAcquisitionLinkProvider(bad)).toThrow(ProviderConfigurationError);
    }
  });

  it('refuses a canonical URL that carries anything but the slug (FR-LINK-006)', async () => {
    const provider = new TenjinAcquisitionLinkProvider(TEMPLATE);
    for (const bad of [
      'https://go-dev.gogo.id.vn/l/Af82XcAf82XcAf82XcAf82?user=123',
      'https://go-dev.gogo.id.vn/l/Af82XcAf82XcAf82XcAf82#token',
      'https://a:b@go-dev.gogo.id.vn/l/Af82XcAf82XcAf82XcAf82',
      'http://go-dev.gogo.id.vn/l/Af82XcAf82XcAf82XcAf82',
      'https://go-dev.gogo.id.vn/r/invite-code',
      'not a url',
    ]) {
      await expect(provider.createTrackingUrl({ canonicalUrl: bad })).rejects.toBeInstanceOf(
        ProviderInvalidRequestError,
      );
    }
  });

  it('the null provider attaches nothing, which is a valid environment state', async () => {
    await expect(
      new NoAcquisitionLinkProvider().createTrackingUrl({ canonicalUrl: CANONICAL }),
    ).resolves.toBeNull();
  });
});
