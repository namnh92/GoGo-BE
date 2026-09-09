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
  type PlaceSearchOptions,
  type ProviderCandidateIdentity,
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
  cidFromGoogleMapsUri,
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
    return this.timed('expand', () => expandShortLink(url, this.fetcher));
  }

  /**
   * #505 — how long each part of a resolution took, as a histogram.
   *
   * A link resolution that "took about four minutes" could not be located:
   * the only timing this path emitted was per provider *request*, so a slow
   * expansion, a slow search, three slow Details and a slow point-in-polygon
   * were indistinguishable from each other and from the DB round trips
   * between them. Three stages, one label, bounded cardinality.
   *
   * Failures are timed too. A stage that threw still consumed the time, and
   * dropping it would make the graph read fastest exactly when it is worst.
   */
  private async timed<T>(stage: 'expand' | 'search' | 'details', fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.metrics.observe('place_link_resolution_stage_seconds', (Date.now() - started) / 1000, {
        stage,
      });
    }
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
      // #505 — only a coordinate the URL states as *the place* is scored.
      // `@lat,lng,z` is the map viewport and is 1.07 km from Sheraton Hanoi
      // West on its own share link; it biases the search below and nothing
      // else. A caller-supplied hint still wins: bulk import knows its row.
      lat: hints.lat ?? parsed.placeLat,
      lng: hints.lng ?? parsed.placeLng,
      ...(parsed.featureId ? { featureCid: parsed.featureId.cid } : {}),
    };

    // Provider id in the URL is authoritative — no search, no ambiguity.
    if (parsed.providerPlaceId) {
      return this.resolveByProviderId(parsed.providerPlaceId, tier, parsed.featureId?.cid);
    }

    const query = merged.name ?? merged.query;
    if (!query) return { status: 'UNRESOLVED', reasonCode: 'NO_QUERY' };

    const searchText = [query, merged.district, merged.city].filter(Boolean).join(' ');
    const bias = searchBias(parsed, merged);

    /**
     * #505 — when the link states an identity, buy the identity.
     *
     * The free Text Search answers with ids and nothing else, so the only way
     * to learn which hit the link names is to fetch Place Details for each and
     * read its `googleMapsUri` — three Enterprise Details at $20 apiece to
     * find one place, and a place Google ranks fourth or fifth is simply
     * unreachable. `Bến Bạch Đằng` in Ho Chi Minh City is the fifth result for
     * its own name, behind a park, a pier and a water-bus stop within 300 m.
     *
     * Asking Text Search for `places.googleMapsUri` moves it to the Pro SKU
     * ($32/1,000, verified 2026-09-09), and that one request answers the
     * question for **ten** candidates at once. Total against the alternatives,
     * per 1,000 resolutions:
     *
     *   free search + 3 Details   $0  + 3×$20 = $60   (misses rank 4+)
     *   free search + 10 Details  $0  + 10×$20 = $200 (finds it)
     *   Pro search  + 1 Details   $32 + 1×$20 = $52   (finds it)
     *
     * So it is cheaper *and* more correct — but only because there is a CID to
     * compare against. A link without one has nothing to pick with, and pays
     * the free search below.
     *
     * The window is bounded (`IDENTITY_CANDIDATE_LIMIT`), the ids are reused
     * for scoring when no CID matches, and no second search is made either
     * way.
     */
    const identified = merged.featureCid
      ? await this.timed('search', () =>
          this.safeIdentities(searchText, PlaceResolverService.IDENTITY_CANDIDATE_LIMIT, bias),
        )
      : null;
    if (identified) {
      const hit = identified.find(
        (candidate) => cidFromGoogleMapsUri(candidate.googleMapsUri) === merged.featureCid,
      );
      if (hit) {
        this.metrics.increment('place_link_cid_lookup_total', { result: 'matched' });
        return this.resolveByProviderId(hit.providerPlaceId, tier, undefined, 'CID_EXACT_MATCH');
      }
      this.metrics.increment('place_link_cid_lookup_total', {
        result: identified.length === 0 ? 'not_found' : 'unmatched',
      });
    }

    const ids = identified
      ? // Reuse what the paid search already returned rather than repeating it
        // on the free SKU: the ranking is the same and a second request would
        // be a second request.
        identified.slice(0, PlaceResolverService.CANDIDATE_LIMIT).map((c) => c.providerPlaceId)
      : await this.timed('search', () => this.safeCandidates(searchText, bias));
    if (ids.length === 0) return { status: 'UNRESOLVED', reasonCode: 'NOT_FOUND' };

    // One unusable candidate does not sink the others: it drops out and the
    // rest are still scored.
    const detailed = (
      await this.timed('details', () => Promise.all(ids.map((id) => this.safeDetails(id, tier))))
    )
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
    /**
     * The CID the same URL carried, when it carried one (#505).
     *
     * A link that names one place by `place_id` and a different one by `ftid`
     * is not a link anybody can act on, and picking whichever field was read
     * first would be a silent choice between two identities. It is refused.
     */
    expectedCid?: string | undefined,
    /** How the id was learned, for the decision's own reasons. */
    via: 'EXACT_PROVIDER_ID' | 'CID_EXACT_MATCH' = 'EXACT_PROVIDER_ID',
  ): Promise<ResolveOutcome> {
    const looked = await this.timed('details', () => this.safeDetails(providerPlaceId, tier));
    if (!looked.ok) return { status: 'UNRESOLVED', reasonCode: looked.reasonCode };
    const { details } = looked;
    const target = toTarget(details);
    if (expectedCid && target.providerCid && target.providerCid !== expectedCid) {
      this.metrics.increment('place_link_identity_conflict_total', { source: 'cid_vs_place_id' });
      return { status: 'UNRESOLVED', reasonCode: 'LINK_IDENTITY_CONFLICT' };
    }
    return { status: 'RESOLVED', decision: exactProviderMatch(target, via), details };
  }

  /**
   * How many provider hits get scored. Small on purpose: each one costs a
   * `details` call (spec §6.2 keeps the search itself IDs-only), and past the
   * first few Google's own ranking is better evidence than our re-scoring.
   */
  private static readonly CANDIDATE_LIMIT = 3;

  /**
   * How wide the **identity** search looks. Larger than `CANDIDATE_LIMIT`
   * because it costs nothing more: Text Search bills per request, not per
   * result, and the candidates it returns are read rather than fetched. Ten
   * is Google's own page size and reaches the rank-five case that prompted
   * this; only the one that matches is ever paid for.
   */
  private static readonly IDENTITY_CANDIDATE_LIMIT = 10;

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

  /**
   * The paid identity search, with the same "a provider that answered is an
   * outcome" split as `safeCandidates`. A failure here is not fatal: the
   * caller falls back to scoring, so an outage costs precision, not the
   * resolution.
   */
  private async safeIdentities(
    query: string,
    limit: number,
    bias?: PlaceSearchOptions['bias'],
  ): Promise<ProviderCandidateIdentity[]> {
    try {
      return await this.provider.searchCandidateIdentities(query, limit, {
        ...(bias ? { bias } : {}),
      });
    } catch (err) {
      PlaceResolverService.rethrowIfOperational(err);
      return [];
    }
  }

  private async safeCandidates(
    query: string,
    bias?: PlaceSearchOptions['bias'],
  ): Promise<string[]> {
    try {
      return await this.provider.searchCandidates(query, PlaceResolverService.CANDIDATE_LIMIT, {
        ...(bias ? { bias } : {}),
      });
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

/**
 * How tightly to bias the Text Search, and on what (#505).
 *
 * Two radii because the URL states two different things and only one of them
 * is about the place:
 *
 * - **An exact coordinate** (`!8m2!3d…!4d…`, or a `?q=<lat>,<lng>` the user
 *   typed) gets a tight circle. Verified against the live API: `Cafe Phê La`
 *   unbiased does not return the branch the link points at anywhere in its top
 *   three; biased to that coordinate it comes back first.
 * - **The viewport** (`@lat,lng,z`) gets a wide one. It is where the map was
 *   centred, which is worth something as a hint about the city and nothing as
 *   a claim about the address — a share link for Sheraton Hanoi West centres
 *   1.07 km from the hotel.
 *
 * A caller-supplied coordinate (bulk import's own row) is treated as exact,
 * because it is the row's own assertion rather than a screen position.
 *
 * `EXACT_BIAS_M` is deliberately larger than the coordinates are precise:
 * Google's own point and the link's rounding disagree by tens of metres, and
 * this is a bias, so being generous costs ranking rather than answers.
 */
const EXACT_BIAS_M = 250;
const VIEWPORT_BIAS_M = 5_000;

function searchBias(
  parsed: MapsUrlHints,
  merged: MatchInput,
): PlaceSearchOptions['bias'] | undefined {
  if (merged.lat !== undefined && merged.lng !== undefined) {
    return { lat: merged.lat, lng: merged.lng, radiusMeters: EXACT_BIAS_M };
  }
  if (parsed.viewportLat !== undefined && parsed.viewportLng !== undefined) {
    return {
      lat: parsed.viewportLat,
      lng: parsed.viewportLng,
      radiusMeters: VIEWPORT_BIAS_M,
    };
  }
  return undefined;
}

export function toTarget(d: ResolvedProviderPlace): MatchTarget {
  return {
    googlePlaceId: d.providerPlaceId,
    name: d.name,
    address: d.addressText,
    lat: d.lat,
    lng: d.lng,
    // #505 — the CID Google publishes for this place, so a share link's `ftid`
    // has something authoritative to be compared against. Absent is ordinary.
    providerCid: cidFromGoogleMapsUri(d.googleMapsUri),
  };
}
