import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Db } from '@gogo/database';
import {
  PLACE_PROVIDER,
  ProviderConfigurationError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  type PlaceProviderPort,
  type ResolvedProviderPlace,
} from '@gogo/providers';
import { DB } from '../../shared/tokens';
import {
  decideMatch,
  exactProviderMatch,
  type MatchDecision,
  type MatchInput,
  type MatchTarget,
} from '../domain/match-score';
import { expandShortLink, parseMapsUrl, type Fetcher } from '../domain/maps-url';
import { providerScore, type RatingPriors } from '../domain/quality-score';

export type ResolveOutcome =
  | { status: 'RESOLVED'; decision: MatchDecision; details: ResolvedProviderPlace }
  | { status: 'NEEDS_CONFIRMATION'; decision: MatchDecision }
  | { status: 'UNRESOLVED'; reasonCode: string; decision?: MatchDecision };

/**
 * PI-BE-004/005 — one resolver for CMS rows and Mobile links. Callers never
 * touch the provider: URL → (expand) → provider id or text search → scored
 * decision. HTML is never fetched or parsed (FR-INGEST-001/002).
 */
@Injectable()
export class PlaceResolverService {
  constructor(
    @Inject(PLACE_PROVIDER) private readonly provider: PlaceProviderPort,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Injected in tests; real runs use global fetch with manual redirects. */
  private readonly fetcher: Fetcher = (url, init) =>
    fetch(url, { method: init.method, redirect: init.redirect, signal: init.signal });

  async resolveFromUrl(url: string, hints: MatchInput = {}): Promise<ResolveOutcome> {
    let parsed = parseMapsUrl(url);
    if (!parsed.ok) return { status: 'UNRESOLVED', reasonCode: parsed.reasonCode };

    if (parsed.value.needsExpansion) {
      parsed = await expandShortLink(url, this.fetcher);
      if (!parsed.ok) return { status: 'UNRESOLVED', reasonCode: parsed.reasonCode };
    }

    const merged: MatchInput = {
      ...hints,
      name: hints.name ?? parsed.value.query,
      lat: hints.lat ?? parsed.value.lat,
      lng: hints.lng ?? parsed.value.lng,
    };

    // Provider id in the URL is authoritative — no search, no ambiguity.
    if (parsed.value.providerPlaceId) {
      const details = await this.safeDetails(parsed.value.providerPlaceId);
      if (!details) return { status: 'UNRESOLVED', reasonCode: 'NOT_FOUND' };
      return { status: 'RESOLVED', decision: exactProviderMatch(toTarget(details)), details };
    }

    const query = merged.name;
    if (!query) return { status: 'UNRESOLVED', reasonCode: 'NO_QUERY' };

    const searchUrl = `https://www.google.com/maps/place/${encodeURIComponent(
      [query, merged.district, merged.city].filter(Boolean).join(' '),
    )}`;
    const candidateId = await this.safeResolve(searchUrl);
    if (!candidateId) return { status: 'UNRESOLVED', reasonCode: 'NOT_FOUND' };

    const details = await this.safeDetails(candidateId);
    if (!details) return { status: 'UNRESOLVED', reasonCode: 'NOT_FOUND' };

    const decision = decideMatch(merged, [toTarget(details)]);
    if (decision.outcome === 'RESOLVED_AUTOMATICALLY') {
      return { status: 'RESOLVED', decision, details };
    }
    if (decision.outcome === 'NEEDS_CONFIRMATION') {
      return { status: 'NEEDS_CONFIRMATION', decision };
    }
    return { status: 'UNRESOLVED', reasonCode: 'LOW_CONFIDENCE', decision };
  }

  /**
   * A provider that *answered* is an outcome (FR-INGEST-002): "Google looked
   * and found nothing" is a fact about the world, and `null` is the right way
   * to say it.
   *
   * A provider that could not answer is not an outcome, and #279 is what
   * happens when the two are collapsed. Quota already propagated for this
   * reason — a bulk job pauses instead of marking thousands of good rows
   * unresolvable — and exactly the same argument covers a disabled API, an
   * invalid key and an upstream outage. Reporting any of them as `null` tells
   * a user their real place does not exist, and tells monitoring nothing at
   * all, because a 201 is a success.
   */
  private static rethrowIfOperational(err: unknown): void {
    if (err instanceof ProviderQuotaExceededError) throw err;
    if (err instanceof ProviderConfigurationError) throw err;
    if (err instanceof ProviderUnavailableError) throw err;
  }

  private async safeResolve(url: string): Promise<string | null> {
    try {
      return await this.provider.resolveUrl(url);
    } catch (err) {
      PlaceResolverService.rethrowIfOperational(err);
      return null;
    }
  }

  private async safeDetails(id: string): Promise<ResolvedProviderPlace | null> {
    try {
      return await this.provider.details(id);
    } catch (err) {
      PlaceResolverService.rethrowIfOperational(err);
      return null;
    }
  }

  /**
   * PI-BE-008 priors: category-city mean → city mean → global mean, computed
   * from the published corpus (falls back to 4.0 on an empty catalog).
   */
  async ratingPriors(areaKey?: string | null, categoryKey?: string | null): Promise<RatingPriors> {
    const rows = await this.db.execute(sql`
      select
        (select avg(rating)::float8 from places where status = 'published' and rating is not null)
          as global_mean,
        (select avg(p.rating)::float8 from places p
          where p.status = 'published' and p.rating is not null
            and ${areaKey ?? null}::text is not null and p.area_key = ${areaKey ?? null})
          as city_mean,
        (select avg(p.rating)::float8 from places p
          join place_taxonomies pt on pt.place_id = p.id
          join taxonomies t on t.id = pt.taxonomy_id and t.kind = 'category'
          where p.status = 'published' and p.rating is not null
            and ${areaKey ?? null}::text is not null and p.area_key = ${areaKey ?? null}
            and ${categoryKey ?? null}::text is not null and t.key = ${categoryKey ?? null}
          having count(*) >= 5)
          as category_city_mean
    `);
    const r = rows.rows[0] as {
      global_mean: number | null;
      city_mean: number | null;
      category_city_mean: number | null;
    };
    return {
      global: r?.global_mean ?? 4.0,
      city: r?.city_mean ?? undefined,
      categoryCity: r?.category_city_mean ?? undefined,
    };
  }

  async scoreFor(
    details: ResolvedProviderPlace,
    areaKey?: string | null,
    categoryKey?: string | null,
  ): Promise<number> {
    const priors = await this.ratingPriors(areaKey, categoryKey);
    return providerScore(details.rating, details.ratingCount, priors);
  }
}

export function toTarget(d: ResolvedProviderPlace): MatchTarget {
  return {
    googlePlaceId: d.providerPlaceId,
    name: d.name,
    address: d.addressText,
    lat: d.lat,
    lng: d.lng,
  };
}
