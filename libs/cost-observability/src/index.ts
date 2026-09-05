/**
 * `@gogo/cost-observability` — epic §39 (COST-BE-029, #388).
 *
 * The Cost Center as its own package: definitions (`domain`), prices
 * (`pricing`), the ports generic code talks through (`ports`), the read/write
 * services (`application`), and one folder per external provider
 * (`providers/<provider>`).
 *
 * It depends only on `@gogo/database`, `@gogo/observability` and
 * `@gogo/providers` — never on `@gogo/modules`, which re-exports this. The one
 * dependency that could not come with it is the audit writer, inverted into
 * `ports/audit.port.ts`.
 *
 * `@gogo/modules` re-exports every name below for one release, so no consumer
 * had to change import paths in #388.
 */

// Ledger and budget guard (COST-BE-002, #335)
export {
  COST_USAGE_LEDGER,
  DbUsageLedger,
  DEFAULT_LEDGER_FLUSH_MS,
  meterRowsFor,
  type UsageLedgerOptions,
} from '../application/usage-ledger';
export {
  ProviderBudgetService,
  budgetLimitsFrom,
  operationEnvSuffix,
  unitsEnvKey,
  type BudgetLimits,
  type BudgetScope,
  type ReserveRefusal,
  type ReserveRequest,
  type ReserveResult,
} from '../application/provider-budget.service';
export {
  ProviderUsageReportService,
  type ProviderCostLine,
  type ProviderCostReport,
} from '../application/usage-report.service';
export {
  CostEstimatorService,
  ESTIMATOR_SOURCE,
  allowanceWalkStart,
  defaultRecomputeRange,
  planEstimates,
  type EstimatePlan,
  type EstimatedCostRow,
  type MeterUsageRow,
  type RecomputeResult,
} from '../application/cost-estimator.service';
export {
  OPS_PROVIDERS,
  PRICING_CURRENCY,
  PRICING_VERSION,
  PROVIDER_PRICING,
  freeCapAdjustedCostMicros,
  knownOperations,
  listCostMicros,
  microsToMinorUnits,
  operationForSku,
  pricingFor,
  providerOf,
  staticCostGaps,
  utcDay,
  type CostGap,
  type OpsProvider,
  type PricingRow,
} from '../pricing/provider-pricing';
export { CAPABILITIES, isCapability, type Capability } from '../domain/capabilities';
export {
  COST_REGISTRY,
  COST_REGISTRY_DATA,
  CostRegistry,
  RegistryError,
  assertCapabilitiesKnown,
  type BillingSkuDefinition,
  type MeterUnit,
  type OperationDefinition,
  type ProviderDefinition,
  type ProviderStatus,
  type RegistryData,
  type RuntimeSurface,
  type ServiceCategory,
  type ServiceDefinition,
  type UsageMeterDefinition,
} from '../domain/registry';
export {
  RUNTIME_COVERAGES,
  providerRuntime,
  serviceRuntime,
  type OperationCount,
  type ProviderRuntime,
  type RuntimeCoverage,
  type ServiceRuntime,
} from '../domain/runtime-coverage';
export {
  COST_DATA_FRESHNESSES,
  COST_SOURCE_KINDS,
  costDataFreshness,
  providerCostSourceKind,
  serviceCostSourceKind,
  type CostDataFacts,
  type CostDataFreshness,
  type CostSource,
  type CostSourceKind,
} from '../domain/cost-source';
export {
  PRICING_MODELS,
  PRICING_RULES,
  estimateMicros,
  newestEffectiveFrom,
  ruleInForce,
  type EstimateResult,
  type FreeAllowance,
  type PricingModel,
  type PricingRule,
  type PricingTier,
} from '../pricing/pricing-rules';
export {
  type ActualCostCollector,
  type CollectContext,
  type Confidence,
  type CostBasis,
  type CostEstimate,
  type CostEstimator,
  type CostSample,
  type FixedCostItem,
  type FixedCostProvider,
  type QuotaCollector,
  type QuotaSnapshot,
  type UsageCollector,
  type UsageSample,
} from '../ports/collectors.port';
export { AdapterRegistryError, CostAdapterRegistry } from '../ports/adapter-registry';
export {
  FRESHNESS_STATUSES,
  freshnessStatus,
  nextAttemptDelayMs,
  type FreshnessFacts,
  type FreshnessStatus,
} from '../domain/freshness';
export {
  MONITORING_COST_MODELS,
  PER_COLLECTOR_APPROVAL_LINE_MICROS,
  defaultMonitoringBudgetMicros,
  isEnabledIn,
  monitoringCostSummary,
  type CollectorDefinition,
  type CollectorRunContext,
  type CollectorRunResult,
  type MonitoringCost,
  type MonitoringCostModel,
  type MonitoringCostSummary,
  type RetryPolicy,
} from '../domain/collector';
export {
  CollectorSchedulerService,
  type CollectorOutcome,
  type CollectorTickReport,
  type SchedulerLogger,
} from '../application/collector-scheduler.service';
export { ledgerFreshnessCollector } from '../application/ledger-freshness.collector';
export {
  CLOUDFLARE_R2_COLLECTOR_ID,
  CLOUDFLARE_SOURCE,
  CLOUDFLARE_WORKERS_COLLECTOR_ID,
  cloudflareCollectorOptionsFromEnv,
  cloudflareCollectors,
  listFromEnv,
  r2Samples,
  workersSamples,
  type CloudflareCollectorOptions,
} from '../providers/cloudflare/cloudflare.collector';
export {
  UPSTASH_REDIS_COLLECTOR_ID,
  UPSTASH_SOURCE,
  coveredByWindow,
  redisSamples,
  upstashRedisCollector,
  type RedisSampleContext,
  type UpstashCollectorOptions,
} from '../providers/upstash/upstash.collector';
export {
  NEON_POSTGRES_COLLECTOR_ID,
  NEON_SOURCE,
  deltaSamples,
  historySamples,
  neonPostgresCollector,
  readNeonState,
  storageSamples,
  type DeltaMeter,
  type NeonBaseline,
  type NeonCollectorOptions,
  type NeonCounters,
  type NeonSampleContext,
  type NeonStoredState,
} from '../providers/neon/neon.collector';
export {
  AWS_COST_EXPLORER_COLLECTOR_ID,
  AWS_CE_REQUEST_MICROS,
  AWS_SOURCE,
  awsCostExplorerCollector,
  awsCostSamples,
  awsServiceRoute,
  daysBefore,
  monthsOf,
  type AwsCollectorOptions,
} from '../providers/aws/aws.collector';
export {
  GITHUB_ACTIONS_COLLECTOR_ID,
  GITHUB_SOURCE,
  actionsSamples,
  githubActionsCollector,
  monthsFor,
  type GitHubCollectorOptions,
  type GitHubSampleContext,
} from '../providers/github/github.collector';
export {
  TestCostService,
  checkBudget,
  diffSnapshots,
  type MeterKey,
  type MeterSnapshot,
  type StartOptions,
  type TestBudget,
  type TestRunDelta,
  type TestRunDetail,
  type TestRunRecord,
  type TestRunResult,
  type TestRunStatus,
} from '../application/test-cost.service';
export {
  BILLING_CADENCES,
  COST_KINDS,
  FORECAST_MIN_ELAPSED_DAYS,
  WARNING_PCT,
  costBudgetStatus,
  daysInMonth,
  elapsedDays,
  emptyByKind,
  inScope,
  spend,
  usageProjectionMicros,
  winningRows,
  type BillingCadence,
  type CostBudgetScope,
  type CostBudgetState,
  type CostBudgetStatus,
  type CostKind,
  type CostRow,
  type ScopeProjection,
  type SpendBreakdown,
} from '../domain/budget';
export {
  EMPTY_SCHEDULE,
  monthForecast,
  scopeProjection,
  type Commitment,
  type ForecastInput,
  type MonthForecast,
  type MonthSchedule,
  type ScheduledCharge,
  type UsageProjectionReason,
} from '../domain/forecast';
export {
  BudgetService,
  COST_ROW_COLUMNS,
  toCostRow,
  type BudgetRow,
  type MonthOverview,
  type RawCost,
} from '../application/budget.service';
export {
  BACKFILL_MAX_DAYS,
  BACKFILL_SOURCE,
  PrometheusBackfillService,
  reduceDay,
  type BackfillDay,
  type BackfillRange,
  type BackfillResult,
} from '../application/prometheus-backfill.service';
export {
  ReconciliationService,
  reconcile,
  type ReconciliationLine,
} from '../application/reconciliation.service';
export {
  COST_WINDOWS,
  CostCenterService,
  buildProviderRow,
  buildServiceDetail,
  buildServiceRow,
  costCard,
  moneyFacts,
  rowFreshness,
  sourcesForService,
  usageLines,
  windowRange,
  type CostCard,
  type CostCards,
  type CostCenterOptions,
  type CostOverview,
  type CostRowWithMeta,
  type CostStatus,
  type CostWindow,
  type DateRange,
  type FreshnessSource,
  type FreshnessSourceRow,
  type MoneyFacts,
  type OperationUsage,
  type ProviderCostRow,
  type RowBasis,
  type RowFreshness,
  type RowInputs,
  type ServiceCostDetail,
  type ServiceCostRow,
  type UsageLine,
  type UsageRow,
} from '../application/cost-center.service';
export {
  MANUAL_COST_PERIODS,
  MANUAL_COST_SOURCE,
  MANUAL_COST_SOURCE_PREFIX,
  activeInMonth,
  addDays,
  addMonths,
  anchorDayInMonth,
  chargeDays,
  classifyPeriod,
  daysInYear,
  isCalendarDay,
  isManualCostSource,
  manualCostSource,
  manualSchedule,
  materialiseItem,
  nextChargeDay,
  planManualCosts,
  type DayRange,
  type ManualCostItem,
  type ManualCostItemFacts,
  type ManualCostPeriod,
  type ManualCostPlan,
  type ManualCostRowPlan,
} from '../domain/manual-cost';
export {
  ManualCostError,
  ManualCostService,
  type EligibleManualService,
  type ManualCostActor,
  type ManualCostItemInput,
  type ManualCostItemPatch,
  type MaterialiseResult,
} from '../application/manual-cost.service';
export { previousDay, upsertCostSamples, upsertUsageSamples } from '../application/sample-writer';
export { CostQueryService, type CostQueryOptions } from '../application/cost-query.service';
export { refuseAudit, type CostAuditEntry, type CostAuditWriter } from '../ports/audit.port';
