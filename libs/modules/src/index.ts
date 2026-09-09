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
  EDGE_AUTH_HEADER,
  EDGE_AUTH_TOKEN_MIN_LENGTH,
  EDGE_CLIENT_IP_HEADER,
  createEdgeClientIpHook,
  vettedEdgeClientIp,
} from '../identity/application/edge-client-ip';
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
export { campaignOutcome, type CampaignOutcome } from '../notifications/domain/campaign';
export {
  audiencePredicate,
  respectsPushPreference,
} from '../notifications/application/campaign-audience';
export {
  PushSubscriptionsService,
  type PushSubscriptionRegistration,
} from '../notifications/application/push-subscriptions.service';
export {
  IDENTITY_TOKEN_MAX_TTL_SECONDS,
  PushIdentityService,
  parseIdentitySigningKey,
  type PushIdentityToken,
} from '../notifications/application/push-identity.service';

// Share links (LNK-BE-002)
export { ShareLinksModule } from '../links/presentation/share-links.module';
export { ShareLinksService } from '../links/application/share-links.service';
export {
  SHARE_LINK_TYPES,
  SHARE_SLUG_PATTERN,
  newShareSlug,
  type ShareLinkType,
} from '../links/domain/share-link';

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
export { AVATAR_STORAGE_CONFIGURED, MEDIA_UPLOADS_CONFIGURED } from '../uploads/application/tokens';

// Profile (ADR-0022)
export { ProfileModule } from '../profile/presentation/profile.module';
export {
  ProfileService,
  PROFILE_INTEREST_KINDS,
  type ProfilePatch,
  type UserProfile,
} from '../profile/application/profile.service';
export { assertValidSelections, type TaxonomySelections } from '../shared/taxonomy-selections';
export {
  UploadsService,
  UPLOAD_PURPOSES,
  ALLOWED_CONTENT_TYPES,
  AVATAR_CONTENT_TYPES,
  AVATAR_ORIGINAL_PREFIX,
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

// Cost observability — moved to `@gogo/cost-observability` (COST-BE-029, #388,
// epic §39). Re-exported here for one release so no consumer had to change an
// import path in that PR; new code should import the package directly.
export * from '@gogo/cost-observability';

// Administrative units (ADM-002 / #455, ADM-003 / #456, ADR-0019)
export { AdministrativeModule } from '../administrative/presentation/administrative.module';
export { AdministrativeController } from '../administrative/presentation/administrative.controller';
export { AdministrativeAdminController } from '../administrative/presentation/administrative-admin.controller';
export {
  AdministrativePublicationService,
  STALE_MAPPING_SAMPLE_LIMIT,
  type DatasetSummary,
  type StaleMappings,
  type TransitionResult,
  type ValidationSummary,
} from '../administrative/application/administrative-publication.service';
export {
  AUDIT_ACTION as ADMINISTRATIVE_AUDIT_ACTION,
  AUDIT_RESOURCE as ADMINISTRATIVE_AUDIT_RESOURCE,
} from '../administrative/application/administrative-audit';
export { snapshotFingerprint } from '../administrative/application/snapshot-fingerprint';
export {
  AdministrativeTelemetryService,
  type AdministrativeCapability,
  type CapabilityState,
  type ResolverCapability,
} from '../administrative/application/administrative-telemetry.service';
export {
  AdministrativeModerationService,
  type MappingDetail,
  type MappingListItem,
  type ModerationActor,
} from '../administrative/application/administrative-moderation.service';
export {
  assertPlaceApprovable,
  evaluatePlaceApproval,
  publicationOutcomeFor,
  type ApprovalSubject,
  type PublicationOutcome,
} from '../administrative/application/place-approval';
export {
  approvalBlock,
  remediationCategory,
  type ApprovalBlock,
  type ApprovalBlockCode,
  type MappingUnderApproval,
  type RemediationCategory,
} from '../administrative/domain/approval-policy';
export {
  AdministrativeMappingController,
  AdministrativeMappingQueueController,
} from '../administrative/presentation/administrative-moderation.controller';
export {
  AdministrativeBackfillService,
  type BackfillOptions,
  type BackfillResult,
  type BackfillStatus,
} from '../administrative/application/administrative-backfill.service';
export {
  classify,
  count as countBackfillOutcome,
  countResolution,
  emptyCounters,
  type BackfillCounters,
  type BackfillOutcome,
  type BackfillSample,
} from '../administrative/domain/backfill-outcome';
export {
  AdministrativeBoundaryImportService,
  BoundaryValidationError,
  BoundaryVersionConflictError,
  type BoundaryLoadOutcome,
  type BoundaryLoadResult,
  type TopologyReport,
} from '../administrative/application/administrative-boundary-import.service';
export {
  BoundaryArchiveReader,
  BoundaryArchiveUnavailableError,
  type ArchiveOrigin,
  type BoundaryFeature,
  type ResolvedArchive,
} from '../administrative/application/boundary-archive.reader';
export {
  readZipEntries,
  ZipFormatError,
  type ZipEntry,
} from '../administrative/application/zip-archive';
export {
  anomaly,
  validateBoundaries,
  BOUNDARY_SAMPLE_LIMIT,
  type Anomaly,
  type BoundaryFinding,
  type BoundaryGateId,
  type BoundaryMeasurements,
  type BoundarySeverity,
  type BoundaryValidationReport,
} from '../administrative/domain/boundary-validation';
export {
  AdministrativeResolverService,
  type PersistOutcome,
  type PersistResult,
  type ResolveOptions,
} from '../administrative/application/administrative-resolver.service';
export {
  ADMINISTRATIVE_RESOLVER_REPOSITORY,
  AdministrativeResolverRepository,
  type BoundaryMatch,
  type ChangeEdge,
  type UnitRecord,
} from '../administrative/infrastructure/administrative-resolver.repository';
export {
  adjudicate,
  definitionalConfidence,
  PRECEDENCE,
  type AdjudicationInput,
  type Candidate,
  type CurrentMapping,
  type Evidence,
  type Resolution,
  type ResolverReason,
} from '../administrative/domain/resolver';
export {
  applyAutomaticTransition,
  clearsReviewerAttribution,
  isReviewerOwned,
  type MappingMethod,
  type MappingStatus,
  type TransitionDecision,
} from '../administrative/domain/mapping-status';
export {
  evaluateStaleness,
  type ActiveUnit,
  type StaleReason,
  type StaleVerdict,
} from '../administrative/domain/staleness';
export {
  publishRefusal,
  rollbackRefusal,
  VALIDATOR_VERSION,
  type DatasetStatus,
  type PersistedValidation,
  type PublishCandidate,
  type Refusal,
  type RollbackCandidate,
  type ValidationBinding,
} from '../administrative/domain/publication-gates';
export {
  AdministrativeQueryService,
  MAX_LIMIT as ADMINISTRATIVE_MAX_LIMIT,
  type Page as AdministrativePage,
  type UnitDto,
} from '../administrative/application/administrative-query.service';
export {
  ADMINISTRATIVE_DATASET,
  NoPublishedDatasetError,
  type AdministrativeDatasetPort,
} from '../administrative/application/administrative-dataset.port';
export {
  administrativeEtag,
  ifNoneMatchSatisfied,
  type EtagParts,
} from '../administrative/application/administrative-etag';
export {
  ADMINISTRATIVE_REPOSITORY,
  DrizzleAdministrativeRepository,
  type ActiveVersion,
  type AdministrativeRepository,
} from '../administrative/infrastructure/administrative.repository';
export {
  InProcessAdministrativeDatasetCache,
  ACTIVE_VERSION_TTL_MS,
  type CacheStats,
} from '../administrative/infrastructure/in-process-dataset.cache';
export {
  buildSnapshot,
  isCurrent,
  matches,
  unitAt,
  type ChangeRow,
  type DatasetSnapshot,
  type SearchEntry,
  type UnitRow,
} from '../administrative/domain/snapshot';
export {
  AdministrativeImportService,
  BoundaryReleaseRequiredError,
  DuplicateImportError,
  type ImportReport,
} from '../administrative/application/administrative-import.service';
export {
  PinnedSnapshotReader,
  SnapshotChecksumError,
  ADMINISTRATIVE_RESOURCES,
  type Manifest,
  type ManifestSource,
} from '../administrative/application/pinned-snapshot.reader';
export { parseMappingCsv } from '../administrative/application/mapping-csv';
export {
  parseCurrentUnits,
  parseHistoricalUnits,
  REORGANISATION_DATE,
  LEGACY_EFFECTIVE_TO,
  type ParsedUnit,
} from '../administrative/application/unit-snapshot';
export {
  classifyMapping,
  isCanonical,
  summarise,
  type Classified,
  type MappingRow,
  type QuarantineClass,
  type UnitIndex,
} from '../administrative/domain/change-classification';
export {
  combinedChecksum,
  combinedDatasetVersion,
  type DatasetComponents,
} from '../administrative/domain/combined-version';
export {
  deriveUnitType,
  stripTypePrefix,
  type UnitLevel,
  type UnitType,
} from '../administrative/domain/unit-type';

// Administrative source-drift adjudication (ADM-011 / #484)
export {
  AdministrativeOverrideService,
  OVERRIDE_PLACE_SAMPLE_LIMIT,
  QUARANTINE_PAGE_MAX,
  RAW_PAYLOAD_MAX_BYTES,
  type QuarantineCounts,
  type QuarantineListItem,
} from '../administrative/application/administrative-override.service';
export {
  abandonRefusal,
  acceptRefusal,
  decisionRefusal,
  decisionState,
  materializeRefusal,
  DECISION_STATES,
  type DecisionKind,
  type DecisionState,
  type OverrideSet,
} from '../administrative/domain/override-sets';

// Administrative validation and diff (ADM-004 / #457)
export {
  AdministrativeValidationService,
  AFFECTED_PLACE_SAMPLE_LIMIT,
} from '../administrative/application/administrative-validation.service';
export {
  validateDataset,
  countUnits,
  identity as administrativeIdentity,
  RECORD_COUNT_DELTA_THRESHOLD,
  SAMPLE_LIMIT as VALIDATION_SAMPLE_LIMIT,
  type DatasetCounts,
  type DatasetUnderValidation,
  type Finding,
  type GateId,
  type QuarantineSummary,
  type Severity,
  type ValidationReport,
} from '../administrative/domain/validation';
export {
  diffDatasets,
  impactedCodes,
  DIFF_ENTRY_LIMIT,
  type AffectedPlaces,
  type DatasetDiff,
  type DiffCategory,
  type DiffEntry,
  type DiffIdentity,
  type DiffInput,
} from '../administrative/domain/dataset-diff';
