import {
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  type AcquisitionLinkInput,
  type AcquisitionLinkPort,
} from './ports';

/**
 * LNK-BE-003 (#206) — Tenjin deferred deep link.
 *
 * Tenjin campaign links are a tracking template per campaign
 * (`https://track.tenjin.com/v0/click/<id>…`); the deferred target rides on
 * the `deeplink_url` query parameter and the installed app receives it back
 * through the SDK after install. That is the whole integration: string
 * building. No Tenjin credential is involved and none is configured — the
 * Infra manifest records why (`tenjin/*` rows deliberately absent).
 *
 * `campaign`/`source`/`medium` are *not* appended: Tenjin's click URL does not
 * document them as parameters, and a parameter the vendor ignores is a claim
 * we cannot verify. They stay on the `share_links` row for GoGo's own analytics.
 */
export const TENJIN_DEEPLINK_PARAM = 'deeplink_url';

export class TenjinAcquisitionLinkProvider implements AcquisitionLinkPort {
  private readonly template: URL;

  constructor(template: string) {
    let parsed: URL;
    try {
      parsed = new URL(template);
    } catch (cause) {
      throw new ProviderConfigurationError(
        'tenjin.link',
        'MISSING_CREDENTIAL',
        'TENJIN_TRACKING_URL_TEMPLATE is not a URL',
        cause,
      );
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new ProviderConfigurationError(
        'tenjin.link',
        'MISSING_CREDENTIAL',
        'TENJIN_TRACKING_URL_TEMPLATE must be https without credentials',
      );
    }
    if (parsed.searchParams.has(TENJIN_DEEPLINK_PARAM)) {
      throw new ProviderConfigurationError(
        'tenjin.link',
        'MISSING_CREDENTIAL',
        `TENJIN_TRACKING_URL_TEMPLATE must not fix ${TENJIN_DEEPLINK_PARAM}; the link service sets it`,
      );
    }
    this.template = parsed;
  }

  async createTrackingUrl(input: AcquisitionLinkInput): Promise<string> {
    // FR-LINK-006: the only thing that reaches the vendor is the canonical URL,
    // and the canonical URL carries a slug and nothing else. Refuse anything
    // that could smuggle a query string or credentials into the payload.
    let canonical: URL;
    try {
      canonical = new URL(input.canonicalUrl);
    } catch (cause) {
      throw new ProviderInvalidRequestError('tenjin.link', 'INVALID_ARGUMENT', cause);
    }
    if (
      canonical.protocol !== 'https:' ||
      canonical.username ||
      canonical.password ||
      canonical.search ||
      canonical.hash ||
      !/^\/l\/[A-Za-z0-9_-]{6,64}$/.test(canonical.pathname)
    ) {
      throw new ProviderInvalidRequestError('tenjin.link', 'INVALID_ARGUMENT');
    }
    const url = new URL(this.template.toString());
    url.searchParams.set(TENJIN_DEEPLINK_PARAM, canonical.toString());
    return url.toString();
  }
}

/** The honest "no attribution here" — what an environment without a template gets. */
export class NoAcquisitionLinkProvider implements AcquisitionLinkPort {
  async createTrackingUrl(_input: AcquisitionLinkInput): Promise<null> {
    return null;
  }
}
