import { ProviderUnavailableError, type CachePurgePort } from './ports';

/**
 * ADR-0022 — purge a removed public object at the edge.
 *
 * Cloudflare's zone purge-by-URL is free on every plan and takes a list of
 * absolute URLs. It reaches the edge only: a copy a device already fetched
 * stays in that device's cache until it expires on its own, which is why the
 * avatar's `Cache-Control` is a day, not a year, and why deletion is described
 * to users as "no new fetch of that URL succeeds" and nothing stronger.
 */
export type CloudflareCachePurgeConfig = {
  zoneId: string;
  token: string;
  /** Test seam; production uses the global fetch. */
  fetch?: typeof fetch;
};

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const REQUEST_TIMEOUT_MS = 10_000;

export class CloudflareCachePurgeAdapter implements CachePurgePort {
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: CloudflareCachePurgeConfig) {
    this.fetcher = config.fetch ?? fetch;
  }

  async purgeUrls(urls: string[], options: { signal?: AbortSignal } = {}): Promise<void> {
    if (urls.length === 0) return;
    const res = await this.fetcher(
      `${CLOUDFLARE_API_BASE}/zones/${this.config.zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ files: urls }),
        signal: options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new ProviderUnavailableError('cloudflare-cache', `purge ${res.status}`);
  }
}

/**
 * Bound when no purge credential exists. Nothing is purged; a removed avatar
 * keeps answering from the edge for up to its cache lifetime. Logged once at
 * boot, never per call.
 */
export class NoopCachePurge implements CachePurgePort {
  async purgeUrls(): Promise<void> {
    /* no credential, no purge */
  }
}
