import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Db, SubmissionDisplaySnapshot } from '@gogo/database';
import { ProviderBudgetService, budgetLimitsFrom } from '@gogo/cost-observability';
import { PLACE_PROVIDER, type PlaceProviderPort } from '@gogo/providers';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { APP_CONFIG } from '../../shared/config';
import { DB } from '../../shared/tokens';
import {
  ProviderPhotosService,
  type CandidatePhotoReference,
} from '../../search/application/provider-photos.service';
import { deriveCategory } from '../domain/google-types';
import { snapshotFromDetails } from '../domain/submission-display-snapshot';

export type SubmissionDisplayConfig = {
  PLACE_DISPLAY_DAILY_MAX_CALLS?: number;
  PLACE_DISPLAY_DAILY_MAX_LIST_COST_USD?: number;
  PLACE_DISPLAY_DAILY_MAX_UNITS_GOOGLE_DETAILS_QUALITY?: number;
};
type Display = SubmissionDisplaySnapshot & { photo?: CandidatePhotoReference };
type Answer = {
  providerStatus: 'ok' | 'budget_exhausted' | 'not_found' | 'identity_mismatch' | 'unavailable';
  providerDisplay: Display | undefined;
};

/** Budgeted detail refresh only. Authorize the submission BEFORE calling. */
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

  async get(providerId: string, deadline = performance.now() + 6000): Promise<Answer> {
    const expires = Math.min(deadline, performance.now() + 6000);
    const controller = new AbortController();
    // Paid facts are published before optional taxonomy/photo work can time out.
    const bought: { display?: Display } = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.fetch(providerId, expires, controller.signal, bought),
        new Promise<Answer>((resolve) => {
          timer = setTimeout(
            () => {
              controller.abort();
              resolve(
                bought.display
                  ? { providerStatus: 'ok', providerDisplay: bought.display }
                  : this.unavailable('unavailable'),
              );
            },
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
      controller.abort();
    }
  }

  private async fetch(
    providerId: string,
    expires: number,
    signal: AbortSignal,
    bought: { display?: Display },
  ): Promise<Answer> {
    try {
      const grant = await this.budget.reserve(
        { scope: 'google.places.display', operation: 'google.details.quality', calls: 1, units: 1 },
        budgetLimitsFrom('google.places.display', this.config),
      );
      if (!grant.ok) return this.unavailable('budget_exhausted');
      if (signal.aborted || performance.now() >= expires) return this.unavailable('unavailable');
      const details = await this.provider.details(providerId, 'quality');
      if (signal.aborted || performance.now() >= expires) return this.unavailable('unavailable');
      if (!details) return this.unavailable('not_found');
      if (details.providerPlaceId !== providerId) return this.unavailable('identity_mismatch');
      bought.display = snapshotFromDetails(details, null);
      const category = deriveCategory(details);
      const active = category
        ? await this.db.execute(sql`select key from taxonomies
            where kind = 'category' and key = ${category.key} and is_active = true limit 1`)
        : undefined;
      if (!signal.aborted && performance.now() < expires) {
        if (active?.rows.length) bought.display = { ...bought.display, categoryKey: category!.key };
        const photo = await this.photos.candidateReference(providerId, {
          signal,
          deadline: expires,
        });
        if (photo && !signal.aborted && performance.now() < expires)
          bought.display = { ...bought.display, photo };
      }
      return { providerStatus: 'ok', providerDisplay: bought.display };
    } catch {
      return bought.display
        ? { providerStatus: 'ok', providerDisplay: bought.display }
        : this.unavailable('unavailable');
    }
  }

  private unavailable(outcome: Exclude<Answer['providerStatus'], 'ok'>): Answer {
    return { providerStatus: outcome, providerDisplay: undefined };
  }
}
