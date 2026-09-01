import { Module } from '@nestjs/common';
import { ProviderBudgetService } from '../application/provider-budget.service';
import { UsageReportService } from '../application/usage-report.service';

/**
 * COST-BE-002 (#335) — cost accounting and the hard budget guard.
 *
 * No controllers. Nothing here is a public surface: the ops API reads through
 * `CmsOpsMetricsService`, and the budget is consulted by the callers that
 * spend (PR7's refresh worker being the first). `DbUsageLedger` is deliberately
 * absent — it is bound as the `METRICS` port itself in `providers.module.ts`,
 * because wrapping the port is what makes every adapter accounted for without
 * any adapter knowing.
 */
@Module({
  providers: [ProviderBudgetService, UsageReportService],
  exports: [ProviderBudgetService, UsageReportService],
})
export class CostModule {}
