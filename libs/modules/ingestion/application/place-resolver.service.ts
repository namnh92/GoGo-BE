import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import {
  PLACE_PROVIDER,
  ProviderConfigurationError,
  ProviderInvalidRequestError,
  ProviderQuotaExceededError,
  ProviderUnavailableError,
  type PlaceDescriptionTier,
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
import {
  expandShortLink,
  parseMapsUrl,
  type Fetcher,
  type MapsUrlHints,
  type UrlParseResult,
} from '../domain/maps-url';
import { providerScore, type RatingPriors } from '../domain/quality-score';

/** What a details lookup produced, and why, when it produced nothing. */
type DetailsOutcome =
  | { ok: true; details: ResolvedProviderPlace }
  | { ok: false; reasonCode: 'NOT_FOUND' | 'INVALID_URL' };

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
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
  ) {}

  /**
   * Injected in tests; real runs use global fetch with manual redirects.
   *
   * #336: counted, as `google.expand`. There are two short-link expanders in
   * this codebase — the adapter's (`GooglePlacesAdapter.resolveUrl`, counted
   * since #335) and this one, the SSRF-guarded walker every API resolve
   * actually goes through. Only the first was instrumented, so the hop that
   * baseline scenario C2 exists to count emitted nothing at all, and a
   * dashboard reading zero `google.expand` while users pasted short links
   * every day looked correct.
   *
   * Deliberately the same `method` label as the adapter's. They are the same
   * operation against the same host at the same price (free — a redirect
   * chase, not a billed SKU), and splitting the label would make the baseline
   * report one operation as two. PR6 collapses the two implementations into
   * one; until then the counter already tells the truth about the total.
   *
   * Counting only. Not one byte more or less is requested than before — the
   * method, the redirect mode and the timeout are untouched, which is what
   * `do not change Google request behaviour while measuring BEFORE` requires.
   */
  private readonly fetcher: Fetcher = async (url, init) => {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: init.method,
        redirect: init.redirect,
        signal: init.signal,
      });
      this.countExpansion(res.status, started);
      return res;
    } catch (err) {
      // A hop that threw still happened and still took time. Recording it as
      // `error` rather than dropping it is what keeps the count equal to the
      // number of requests that left this process.
      this.countExpansion('error', started);
      throw err;
    }
  };

  private countExpansion(status: number | 'error', started: number): void {
    this.metrics.increment('places_provider_requests_total', {
      method: 'google.expand',
      status,
    });
    this.metrics.observe('place_provider_request_duration_seconds', (Date.now() - started) / 1000, {
      method: 'google.expand',
      status,
    });
  }

  /**
   * URL → what Google Place it names, **without asking Google about it**.
   *
   * Split out for #337: a caller that only needs the id — to look it up in our
   * own catalogue before deciding whether a Details call is warranted — used to
   * have no way to get one except by paying for the whole resolve. Short links
   * still cost one HTTP hop (`google.expand`), because learning the id is what
   * that hop is for; nothing here reaches the Places API.
   *
   * The expansion happens exactly once. A caller that identifies first and then
   * resolves passes the value back in rather than the original URL, so a
   * `maps.app.goo.gl` link is never walked twice.
   */
  async identifyUrl(url: string): Promise<UrlParseResult> {
    const parsed = parseMapsUrl(url);
    if (!parsed.ok) return parsed;
    if (!parsed.value.needsExpansion) return parsed;
    return expandShortLink(url, this.fetcher);
  }

  async resolveFromUrl(
    url: string,
    tier: PlaceDescriptionTier,
    hints: MatchInput = {},
  ): Promise<ResolveOutcome> {
    const identified = await this.identifyUrl(url);
    if (!identified.ok) return { status: 'UNRESOLVED', reasonCode: identified.reasonCode };
    return this.resolveIdentified(identified.value, tier, hints);
  }

  /**
   * The half of `resolveFromUrl` that costs money, over a URL already parsed
   * and expanded.
   *
   * `tier` is the caller's, and it governs **every** Details call this resolve
   * makes — the candidates it scores as well as the one it returns (#338).
   *
   * Scoring genuinely needs only `core`: `MatchTarget` is an id, a name, an
   * address, a coordinate and a primary type, all Pro fields. It would
   * therefore be tempting to always score at `core` and re-fetch the winner at
   * whatever the caller wanted — and that would cost *more*, not less. Three
   * candidates at Pro plus one winner at Enterprise is $71/1k against $60/1k
   * for three at Enterprise. The saving is real only when the caller does not
   * need Enterprise at all, which is exactly what asking it to say so buys.
   *
   * `liveness` is not accepted: a decision needs a name and a coordinate to
   * score, and there is nothing to score without them.
   */
  async resolveIdentified(
    parsed: MapsUrlHints,
    tier: PlaceDescriptionTier,
    hints: MatchInput = {},
  ): Promise<ResolveOutcome> {
    const merged: MatchInput = {
      ...hints,
      // Spec §6.2 step 5 keeps the display query and the name apart. Folding
      // the query into `name` made the scorer treat "Lacaph Coffee … Ho Chi
      // Minh City" as the place's name and penalise every locality token in
      // it, so a correct link could not clear the threshold (#311).
      query: parsed.query,
      lat: hints.lat ?? parsed.lat,
      lng: hints.lng ?? parsed.lng,
    };

    // Provider id in the URL is authoritative — no search, no ambiguity.
    if (parsed.providerPlaceId) return this.resolveByProviderId(parsed.providerPlaceId, tier);

    const query = merged.name ?? merged.query;
    if (!query) return { status: 'UNRESOLVED', reasonCode: 'NO_QUERY' };

    const searchText = [query, merged.district, merged.city].filter(Boolean).join(' ');
    const ids = await this.safeCandidates(searchText);
    if (ids.length === 0) return { status: 'UNRESOLVED', reasonCode: 'NOT_FOUND' };

    // One unusable candidate does not sink the others: it drops out and the
    // rest are still scored.
    const detailed = (await Promise.all(ids.map((id) => this.safeDetails(id, tier))))
      .filter((d): d is { ok: true; details: ResolvedProviderPlace } => d.ok)
      .map((d) => d.details);
    if (detailed.length === 0) return { status: 'UNRESOLVED', reasonCode: 'NOT_FOUND' };

    const decision = decideMatch(merged, detailed.map(toTarget));
    if (decision.outcome === 'RESOLVED_AUTOMATICALLY' && decision.best) {
      const bestId = decision.best.target.googlePlaceId;
      const details = detailed.find((d) => d.providerPlaceId === bestId);
      if (details) return { status: 'RESOLVED', decision, details };
    }
    if (decision.outcome === 'NEEDS_CONFIRMATION') {
      return { status: 'NEEDS_CONFIRMATION', decision };
    }
    return { status: 'UNRESOLVED', reasonCode: 'LOW_CONFIDENCE', decision };
  }

  /**
   * One Details call for an id we already hold.
   *
   * Every caller that knew the Place ID used to build
   * `https://www.google.com/maps?place_id=<id>` and send it back through URL
   * parsing to arrive here — which read as a lookup by link and cost a parse to
   * express "fetch this id". Same request, same tier, said plainly.
   */
  async resolveByProviderId(
    providerPlaceId: string,
    tier: PlaceDescriptionTier,
  ): Promise<ResolveOutcome> {
    const looked = await this.safeDetails(providerPlaceId, tier);
    if (!looked.ok) return { status: 'UNRESOLVED', reasonCode: looked.reasonCode };
    const { details } = looked;
    return { status: 'RESOLVED', decision: exactProviderMatch(toTarget(details)), details };
  }

  /**
   * How many provider hits get scored. Small on purpose: each one costs a
   * `details` call (spec §6.2 keeps the search itself IDs-only), and past the
   * first few Google's own ranking is better evidence than our re-scoring.
   */
  private static readonly CANDIDATE_LIMIT = 3;

  /**
   * A provider that *answered* is an outcome (FR-INGEST-002): "Google looked
   * and found nothing" is a fact about the world, and an empty result is the
   * right way to say it.
   *
   * A provider that could not answer is not an outcome, and #279 is what
   * happens when the two are collapsed. Quota already propagated for this
   * reason — a bulk job pauses instead of marking thousands of good rows
   * unresolvable — and exactly the same argument covers a disabled API, an
   * invalid key and an upstream outage. Reporting any of them as "nothing
   * found" tells a user their real place does not exist, and tells monitoring
   * nothing at all, because a 201 is a success.
   */
  private static rethrowIfOperational(err: unknown): void {
    if (err instanceof ProviderQuotaExceededError) throw err;
    if (err instanceof ProviderConfigurationError) throw err;
    if (err instanceof ProviderUnavailableError) throw err;
  }

  private async safeCandidates(query: string): Promise<string[]> {
    try {
      return await this.provider.searchCandidates(query, PlaceResolverService.CANDIDATE_LIMIT);
    } catch (err) {
      PlaceResolverService.rethrowIfOperational(err);
      return [];
    }
  }

  /**
   * Three outcomes, not two. "Google looked and found nothing" and "Google
   * refused to look because that is not a usable id" are different facts and
   * lead the user to different actions — retry later versus fix the link —
   * so they do not share a reason code (#314).
   */
  private async safeDetails(id: string, tier: PlaceDescriptionTier): Promise<DetailsOutcome> {
    try {
      const details = await this.provider.details(id, tier);
      return details ? { ok: true, details } : { ok: false, reasonCode: 'NOT_FOUND' };
    } catch (err) {
      PlaceResolverService.rethrowIfOperational(err);
      if (err instanceof ProviderInvalidRequestError) {
        return {
          ok: false,
          reasonCode: err.canonicalStatus === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID_URL',
        };
      }
      return { ok: false, reasonCode: 'NOT_FOUND' };
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
