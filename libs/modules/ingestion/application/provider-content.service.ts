import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Db } from '@gogo/database';
import { METRICS, NoopMetrics, type MetricsPort } from '@gogo/observability';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type PlatformConfig } from '../../shared/config';
import { flagEnvironmentOf, resolveBooleanFlag } from '../../shared/feature-flags';
import { DB } from '../../shared/tokens';
import {
  ProviderBudgetService,
  budgetLimitsFrom,
  type BudgetLimits,
  type BudgetScope,
  type ReserveRefusal,
} from '../../cost/application/provider-budget.service';
import {
  toEphemeralProviderContent,
  type ProviderContentAnswer,
  type ProviderContentTier,
} from '../domain/provider-content';
import { PlaceResolverService } from './place-resolver.service';
import { placeProviderUnavailable } from './place-submission.service';

/**
 * The budget scopes an ephemeral fetch may spend under.
 *
 * A subset of `BudgetScope` on purpose: the refresh scope belongs to PR7's
 * scheduled job and the import scope to the bulk pipeline, and neither may be
 * drawn down by an on-demand click. A future caller — the moderation drawer
 * for #346, a consumer surface — adds its own member here *and* its own
 * ceilings, or it does not compile.
 */
export type ProviderContentScope = Extract<BudgetScope, 'google.places.cms_preview'>;

export type ProviderContentRequest = {
  googlePlaceId: string;
  /** No default. What is read decides what is paid for (PR5, #338). */
  tier: ProviderContentTier;
  scope: ProviderContentScope;
};

/** Label values for `place_provider_content_total{outcome}`. */
export const PROVIDER_CONTENT_OUTCOMES = [
  'found',
  'not_found',
  'invalid_id',
  'disabled',
  'refused_budget',
  'provider_error',
] as const;

const NOT_CONFIGURED: ReadonlySet<ReserveRefusal> = new Set([
  'not_configured',
  'operation_not_configured',
  'price_unknown',
]);

/**
 * #341 (PR8) — the one door for rich Google content that is not persisted
 * (ADR-0006 §9.7.3).
 *
 * Every caller that wants Google's *current* answer about a place — as
 * opposed to the identity check PR7 schedules, or the resolve-and-store path
 * ingestion already has — comes through `fetch`. What comes back is an
 * `EphemeralProviderContent`: frozen, explicitly shaped, and not a
 * `ResolvedProviderPlace`, so none of the repositories that persist provider
 * facts can take it.
 *
 * Three things happen before the provider is asked, in this order:
 *
 * 1. **Kill switch.** `place_provider_preview.enabled` (registry default off)
 *    gates the whole boundary. One row in `feature_flags` stops every caller
 *    without a deploy.
 * 2. **Reservation.** One call, one unit, under the caller's scope, priced at
 *    list for the tier asked. The same default-deny as the refresh job: no
 *    ceiling configured means no call made. Never refunded — a fetch that
 *    failed may still have been billed.
 * 3. **The fetch**, through the resolver (ADR-0006 §1: one resolver, no direct
 *    provider access), at exactly the tier asked.
 *
 * And one thing never happens after it: a write. This class holds the database
 * handle for the flag and the reservation only; it has no repository, and the
 * structural test refuses a write statement in this file.
 */
@Injectable()
export class ProviderContentService {
  private readonly limits: Readonly<Record<ProviderContentScope, BudgetLimits>>;

  constructor(
    private readonly resolver: PlaceResolverService,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: PlatformConfig,
    @Optional() @Inject(METRICS) private readonly metrics: MetricsPort = new NoopMetrics(),
    @Optional() private readonly budget: ProviderBudgetService = new ProviderBudgetService(db),
  ) {
    // The validated environment is a flat object of primitives; the budget
    // reader takes the keys it knows and ignores the rest.
    const env = config as unknown as Readonly<
      Record<string, string | number | boolean | undefined>
    >;
    this.limits = {
      'google.places.cms_preview': budgetLimitsFrom('google.places.cms_preview', env),
    };
  }

  async fetch(
    request: ProviderContentRequest,
    now: Date = new Date(),
  ): Promise<ProviderContentAnswer> {
    const { googlePlaceId, tier, scope } = request;
    const enabled = await resolveBooleanFlag(this.db, 'place_provider_preview.enabled', {
      environment: flagEnvironmentOf(this.config.APP_ENV),
    });
    if (!enabled) {
      this.metrics.increment('place_provider_content_total', { scope, tier, outcome: 'disabled' });
      throw AppError.serviceUnavailable(
        'PROVIDER_PREVIEW_DISABLED',
        'Xem dữ liệu Google trực tiếp đang tắt',
        false,
      );
    }

    const reserved = await this.budget.reserve(
      { scope, operation: `google.details.${tier}`, calls: 1, units: 1 },
      this.limits[scope],
    );
    if (!reserved.ok) {
      this.metrics.increment('place_provider_content_total', {
        scope,
        tier,
        outcome: 'refused_budget',
      });
      // Neither is retryable *now*: a ceiling resets at UTC midnight and a
      // missing ceiling resets when an operator sets one. A client that
      // retried in a loop would only add refusals to the metric.
      throw NOT_CONFIGURED.has(reserved.reason)
        ? AppError.serviceUnavailable(
            'PROVIDER_BUDGET_NOT_CONFIGURED',
            'Chưa cấu hình trần chi phí cho thao tác này',
            false,
          )
        : AppError.serviceUnavailable(
            'PROVIDER_BUDGET_EXHAUSTED',
            'Đã chạm trần chi phí trong ngày cho thao tác này',
            false,
          );
    }

    let resolved;
    try {
      resolved = await this.resolver.resolveByProviderId(googlePlaceId, tier);
    } catch (err) {
      // Outage, quota, configuration: the provider could not look. A statement
      // about this deployment, never about the place (#279, PR6).
      this.metrics.increment('place_provider_content_total', {
        scope,
        tier,
        outcome: 'provider_error',
      });
      throw placeProviderUnavailable(err);
    }

    if (resolved.status !== 'RESOLVED') {
      // `resolveByProviderId` never returns NEEDS_CONFIRMATION (one id, one
      // answer); treat anything but RESOLVED/INVALID as "Google found nothing".
      const outcome =
        resolved.status === 'UNRESOLVED' && resolved.reasonCode === 'INVALID_URL'
          ? 'invalid_id'
          : 'not_found';
      this.metrics.increment('place_provider_content_total', { scope, tier, outcome });
      return {
        outcome,
        requestedGooglePlaceId: googlePlaceId,
        tier,
        fetchedAt: now.toISOString(),
      };
    }

    this.metrics.increment('place_provider_content_total', { scope, tier, outcome: 'found' });
    return { outcome: 'found', content: toEphemeralProviderContent(resolved.details, tier, now) };
  }
}
