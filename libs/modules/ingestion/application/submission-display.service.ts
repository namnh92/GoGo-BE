import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db } from '@gogo/database';
import { ProviderBudgetService, budgetLimitsFrom } from '@gogo/cost-observability';
import { PLACE_PROVIDER, type PlaceProviderPort } from '@gogo/providers';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { APP_CONFIG } from '../../shared/config';
import { DB } from '../../shared/tokens';
import { normalizeGoogleAttribution } from '../../shared/attribution';
import { ProviderPhotosService } from '../../search/application/provider-photos.service';
import { deriveCategory } from '../domain/google-types';

export type SubmissionDisplayConfig = {
  PLACE_DISPLAY_DAILY_MAX_CALLS?: number;
  PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD?: number;
  PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_DETAILS_QUALITY?: number;
};

/** Live Google display only. Authorize the submission BEFORE calling this service. */
@Injectable()
export class SubmissionDisplayService {
  private readonly budget: ProviderBudgetService;
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PLACE_PROVIDER) private readonly provider: PlaceProviderPort,
    private readonly photos: ProviderPhotosService,
    @Inject(APP_CONFIG) private readonly config: SubmissionDisplayConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
    @Optional() budget?: ProviderBudgetService,
  ) {
    this.budget = budget ?? new ProviderBudgetService(db);
  }

  async get(providerId: string, deadline = performance.now() + 6000) {
    const expires = Math.min(deadline, performance.now() + 6000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.fetch(providerId, expires),
        new Promise<ReturnType<SubmissionDisplayService['unavailable']>>((resolve) => {
          timer = setTimeout(
            () => resolve(this.unavailable('unavailable')),
            Math.max(0, expires - performance.now()),
          );
        }),
      ]);
      this.metrics.increment('my_place_submission_display_total', {
        outcome: result.providerStatus,
      });
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetch(providerId: string, expires: number) {
    try {
      const grant = await this.budget.reserve(
        { scope: 'google.places.display', operation: 'google.details.quality', calls: 1, units: 1 },
        budgetLimitsFrom('google.places.display', this.config),
      );
      if (!grant.ok) return this.unavailable('budget_exhausted');
      if (performance.now() >= expires) return this.unavailable('unavailable');
      const details = await this.provider.details(providerId, 'quality');
      if (performance.now() >= expires) return this.unavailable('unavailable');
      if (!details) return this.unavailable('not_found');
      // A moved/merged Google identity must not silently change a pending proposal.
      if (details.providerPlaceId !== providerId) return this.unavailable('identity_mismatch');
      const category = deriveCategory(details);
      const active = category
        ? await this.db.execute(sql`select key from taxonomies
            where kind = 'category' and key = ${category.key} and is_active = true limit 1`)
        : undefined;
      if (performance.now() >= expires) return this.unavailable('unavailable');
      const photo = await this.photos.candidateReference(providerId);
      return {
        providerStatus: 'ok' as const,
        providerDisplay: {
          source: 'google_places' as const,
          fetchedAt: new Date().toISOString(),
          attributions: [normalizeGoogleAttribution(details.attribution)],
          googleMapsUri: details.googleMapsUri,
          name: details.name,
          addressShort: details.shortAddress || details.addressText,
          ...(active?.rows.length ? { categoryKey: category!.key } : {}),
          googleRating: details.rating,
          googleRatingCount: details.ratingCount,
          openingHours: details.hours.map(
            ({ dayOfWeek, openMinute, closeMinute, isOvernight }) => ({
              dayOfWeek,
              openMinute,
              closeMinute,
              isOvernight,
            }),
          ),
          ...(photo ? { photo } : {}),
        },
      };
    } catch {
      // Preserve history and decisions during an outage. Never log provider payloads.
      return this.unavailable('unavailable');
    }
  }

  private unavailable(
    outcome: 'budget_exhausted' | 'not_found' | 'identity_mismatch' | 'unavailable',
  ) {
    return { providerStatus: outcome, providerDisplay: undefined };
  }
}
