import type { Db } from '@gogo/database';
import { ProviderUsageReportService, type ProviderCostReport } from './usage-report.service';

export type CostQueryOptions = {
  /** `dev` | `staging` | `prod` — which deployment's rows are ours (#335). */
  environment: string;
  /** Off means the in-process ledger writes nothing; the payload says so. */
  ledgerEnabled: boolean;
};

/**
 * COST-BE-029 (#388) — epic §39: the cost report is composed **here**, not in
 * the CMS module.
 *
 * `costs()` used to live in `cms-observability.service.ts`, which meant the
 * back-office module owned the decision of how a cost report is assembled —
 * which environment it reads, whether the ledger is on, which service does the
 * work. None of that is a CMS concern; the CMS is one caller of a read model
 * that a worker, a script or a second surface could equally want.
 *
 * So the seam moved: this is the composition root for cost reads, and the CMS
 * service is a one-line delegation. Nothing about the payload changed.
 */
export class CostQueryService {
  constructor(
    private readonly db: Db,
    private readonly options: CostQueryOptions,
  ) {}

  /**
   * Cost and quota.
   *
   * Until #335 this returned an empty list unconditionally: there was no
   * billing API, and an in-process SKU counter that resets on deploy cannot
   * answer "today" or "month to date". Both halves are fixed —
   * `provider_usage_daily` survives deploys, and the pricing rules hold a list
   * price — so the endpoint reports money.
   *
   * What has *not* changed is the rule the empty list was protecting:
   *
   * - Nothing here is called `billed`. `basis: 'estimated'` on every line, and
   *   the free-cap arithmetic approximates a per-billing-account cap GoGo
   *   cannot see, labelled `confidence: 'MEDIUM'`.
   * - A provider whose price is unverified (Routes, per matrix element) is
   *   **absent from the money list** and present in `gaps` — a floor with a
   *   currency symbol is still a claim, and that one would be false.
   * - A provider nothing measures (the Maps SDK, which renders on the handset)
   *   is in `gaps` as `not_instrumented`. Never a zero.
   * - With the ledger off, `sourcesConfigured` is false and the list is empty,
   *   exactly as before.
   *
   * A zero that comes back *with* the ledger on is a real measured zero: the
   * operations are instrumented and made no calls this month.
   */
  report(): Promise<ProviderCostReport> {
    return new ProviderUsageReportService(this.db, {
      environment: this.options.environment,
      ledgerEnabled: this.options.ledgerEnabled,
    }).report();
  }
}
