// Shared
export { AppError, type FieldError } from '../shared/app-error';
export { APP_CONFIG, type IdentityConfig } from '../shared/config';
export { DB } from '../shared/tokens';
export { ZodValidationPipe } from '../shared/zod-validation.pipe';

// Identity (BE-BFF-002)
export { IdentityModule } from '../identity/presentation/identity.module';
export { AuthService } from '../identity/application/auth.service';
export { TokenService } from '../identity/application/token.service';
export { PasswordService } from '../identity/application/password.service';
export { IdentityRepository } from '../identity/infrastructure/identity.repository';
export {
  AuthGuard,
  ACCESS_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  REFRESH_COOKIE,
} from '../identity/presentation/auth.guard';
export { CurrentActor, Public, RateLimit } from '../identity/presentation/decorators';
export type { Actor, ActorType } from '../identity/domain/actor';

// Rooms (BE-BFF-003/004, BE-BFF-015)
export { RoomsModule } from '../rooms/presentation/rooms.module';
export { RoomsService } from '../rooms/application/rooms.service';
export { RoomPolicy } from '../rooms/presentation/room-policy';
export { budgetPerPerson, budgetTotal, isOverBudget, type Budget } from '../rooms/domain/budget';
export {
  assertConstraintsEditable,
  assertDecisionMode,
  assertTransition,
  type DecisionMode,
  type RoomStatus,
  type RoomType,
} from '../rooms/domain/room-state';

// Preferences (BE-BFF-005)
export { PreferencesModule } from '../preferences/presentation/preferences.module';

// Places (taxonomy for now)
export { PlacesModule } from '../places/presentation/places.module';

// Search (SE-002..005, SE-010, BE-BFF-006)
export { SearchModule } from '../search/presentation/search.module';
export { SearchService, openStateAt } from '../search/application/search.service';
export { SearchRepository } from '../search/infrastructure/search.repository';
export { normalizeVietnamese, toSearchQuery } from '../search/domain/normalize';

// Suggestions + Plans (SG-001..008, BE-BFF-007/008/014)
export { SuggestionsModule } from '../suggestions/presentation/suggestions.module';
export { PlansModule } from '../plans/presentation/plans.module';
export { SuggestionService } from '../suggestions/application/suggestion.service';
export { PlansService } from '../plans/application/plans.service';
export { hardFilter } from '../suggestions/domain/hard-filter';
export { scoreCandidate } from '../suggestions/domain/scoring';
export { rankWithFairness } from '../suggestions/domain/fairness';
export { buildItinerary } from '../suggestions/domain/optimizer';
export { coupleMatches, resolveWinner, tallyVotes } from '../suggestions/domain/decision';

// User content + notifications (BE-BFF-009/010)
export { ReviewsModule } from '../reviews/presentation/reviews.module';
export { NotificationsModule } from '../notifications/presentation/notifications.module';
export { UserContentService } from '../reviews/application/user-content.service';
export {
  OutboxDispatcher,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_BACKOFF_SECONDS,
} from '../notifications/application/outbox-dispatcher';
export { CampaignDispatcher } from '../notifications/application/campaign-dispatcher';

// Place import + areas (BE-BFF-013/016)
export { PlaceImportService } from '../places/application/place-import.service';

// CMS (CMS-001..010)
export { CmsModule } from '../cms/presentation/cms.module';
export { AdminAuthService } from '../cms/application/admin-auth.service';

// Place ingestion (PI-*)
export { IngestionModule } from '../ingestion/presentation/ingestion.module';
export { PlaceResolverService } from '../ingestion/application/place-resolver.service';
export { PlaceDedupService } from '../ingestion/application/place-dedup.service';
export { PlaceSubmissionService } from '../ingestion/application/place-submission.service';
export {
  PlaceImportJobService,
  type ImportMode,
} from '../ingestion/application/place-import-job.service';
export {
  PlaceRefreshService,
  REFRESH_BATCH_SIZE,
  REFRESH_CALL_BUDGET_MS,
  type PlaceRefreshOptions,
  type PlaceRefreshReport,
} from '../ingestion/application/place-refresh.service';
export {
  BACKOFF_BASE_DAYS,
  MAX_REFRESH_ATTEMPTS,
  REFRESH_INTERVAL_DAYS,
  TRANSIENT_BASE_MINUTES,
  TRANSIENT_MAX_MINUTES,
  REFRESH_OUTCOMES,
  classifyLiveness,
  scheduleFor,
  type RefreshAnswer,
  type RefreshOutcome,
  type RefreshSchedule,
} from '../ingestion/domain/place-refresh';
export {
  RESOLUTION_ATTESTATION_VERSION,
  RESOLUTION_PURPOSE,
  signResolutionAttestation,
  verifyResolutionAttestation,
  type ResolutionAttestation,
} from '../ingestion/domain/resolution-attestation';
export {
  INGEST_LIMITS,
  IngestFileError,
  detectFormat,
  parseCsv,
  parseTabularSource,
  parseXlsx,
  type SheetGrid,
} from '../ingestion/domain/tabular';
export { applyMapping, resolveMapping, CANONICAL_FIELDS } from '../ingestion/domain/column-mapping';
export { validateRow, type NormalizedImportRow } from '../ingestion/domain/template';
export { buildErrorReportCsv, escapeCsvCell } from '../ingestion/domain/error-report';
export { parseMapsUrl, expandShortLink } from '../ingestion/domain/maps-url';
export { decideMatch, scoreMatch } from '../ingestion/domain/match-score';
export { providerScore, compositeQualityScore } from '../ingestion/domain/quality-score';
export {
  parsePrice,
  parseAudiences,
  parseVibes,
  mapLegacyHeader,
} from '../ingestion/domain/normalize-row';

// Platform
export { IdempotencyInterceptor } from '../shared/idempotency.interceptor';
export { writeOutbox, type DomainEventInput } from '../shared/outbox';
export { PrivacyJobs, type PrivacyRunReport } from '../shared/privacy-jobs';
export {
  currentRequestContext,
  runWithRequestContext,
  type RequestContext,
} from '../shared/request-context';
export { writeAudit, type AuditInput } from '../shared/audit';
export { normalizeGoogleAttribution } from '../shared/attribution';
export { MATERIAL_MOVE_METERS, invalidateTravelOnMove } from '../shared/place-relocation';
export { EmergencyTakedownService } from '../cms/application/emergency-takedown.service';
export {
  TravelTimeService,
  ROUTES_ENABLED,
  type TravelTarget,
} from '../travel/application/travel-time.service';
export { TravelModule } from '../travel/presentation/travel.module';

export { RealtimeBusModule } from '../realtime/presentation/realtime.module';
export { RoomEventsModule } from '../realtime/presentation/room-events.module';
export { ROOM_EVENT_BUS, type RoomEventBus } from '../realtime/application/room-event-bus';
export {
  ROOM_EVENT_TYPES,
  type RoomEvent,
  type RoomEventType,
} from '../realtime/domain/room-event';

export { UploadsModule } from '../uploads/presentation/uploads.module';
export {
  UploadsService,
  UPLOAD_PURPOSES,
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  type UploadPurpose,
} from '../uploads/application/uploads.service';

export { FeedbackModule } from '../suggestions/presentation/feedback.module';
export {
  FeedbackService,
  AI_FEEDBACK_ENABLED,
  FEEDBACK_TIMEOUT_MS,
  FEEDBACK_TIMEOUT_OVERRIDE,
  type FeedbackOutcome,
} from '../suggestions/application/feedback.service';
export {
  validateFeedback,
  feedbackProposalSchema,
  FEEDBACK_REASON_CODES,
  type FeedbackProposal,
  type FeedbackContext,
  type ValidatedFeedback,
} from '../suggestions/domain/feedback';

export {
  ExperimentsService,
  RANKING_EXPERIMENT,
  type Assignment,
} from '../suggestions/application/experiments.service';
export { assign, bucket, CONTROL } from '../suggestions/domain/assignment';
export { SUGGESTION_LATENCY_BUDGET_MS } from '../suggestions/application/suggestion.service';

// Cost observability (COST-BE-002, #335)
export {
  COST_USAGE_LEDGER,
  DbUsageLedger,
  DEFAULT_LEDGER_FLUSH_MS,
  meterRowsFor,
  type UsageLedgerOptions,
} from '../cost/application/usage-ledger';
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
} from '../cost/application/provider-budget.service';
export {
  ProviderUsageReportService,
  type ProviderCostLine,
  type ProviderCostReport,
} from '../cost/application/usage-report.service';
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
} from '../cost/application/cost-estimator.service';
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
} from '../cost/domain/provider-pricing';
export { CAPABILITIES, isCapability, type Capability } from '../cost/domain/capabilities';
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
  type ServiceCategory,
  type ServiceDefinition,
  type UsageMeterDefinition,
} from '../cost/domain/registry';
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
} from '../cost/domain/pricing-rules';
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
} from '../cost/ports/collectors.port';
export { AdapterRegistryError, CostAdapterRegistry } from '../cost/ports/adapter-registry';
export {
  FRESHNESS_STATUSES,
  freshnessStatus,
  nextAttemptDelayMs,
  type FreshnessFacts,
  type FreshnessStatus,
} from '../cost/domain/freshness';
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
} from '../cost/domain/collector';
export {
  CollectorSchedulerService,
  type CollectorOutcome,
  type CollectorTickReport,
  type SchedulerLogger,
} from '../cost/application/collector-scheduler.service';
export { ledgerFreshnessCollector } from '../cost/application/ledger-freshness.collector';
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
} from '../cost/application/test-cost.service';
export {
  FORECAST_MIN_ELAPSED_DAYS,
  WARNING_PCT,
  costBudgetStatus,
  daysInMonth,
  elapsedDays,
  forecastMonthMicros,
  inScope,
  spend,
  winningRows,
  type CostBudgetScope,
  type CostBudgetState,
  type CostBudgetStatus,
  type CostRow,
  type SpendBreakdown,
} from '../cost/domain/budget';
export {
  BudgetService,
  type BudgetRow,
  type MonthOverview,
} from '../cost/application/budget.service';
export {
  BACKFILL_MAX_DAYS,
  BACKFILL_SOURCE,
  PrometheusBackfillService,
  reduceDay,
  type BackfillDay,
  type BackfillRange,
  type BackfillResult,
} from '../cost/application/prometheus-backfill.service';
export {
  ReconciliationService,
  reconcile,
  type ReconciliationLine,
} from '../cost/application/reconciliation.service';
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
} from '../cost/application/cost-center.service';
export {
  MANUAL_COST_PERIODS,
  MANUAL_COST_SOURCE,
  MANUAL_COST_SOURCE_PREFIX,
  addDays,
  coveredRange,
  dailyShareMicros,
  daysInYear,
  eachDay,
  isCalendarDay,
  isManualCostSource,
  manualCostSource,
  materialiseItem,
  planManualCosts,
  type DayRange,
  type ManualCostItem,
  type ManualCostItemFacts,
  type ManualCostPeriod,
  type ManualCostPlan,
  type ManualCostRowPlan,
} from '../cost/domain/manual-cost';
export {
  ManualCostError,
  ManualCostService,
  type EligibleManualService,
  type ManualCostActor,
  type ManualCostItemInput,
  type ManualCostItemPatch,
  type MaterialiseResult,
} from '../cost/application/manual-cost.service';
