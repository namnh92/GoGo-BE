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
export { OutboxDispatcher } from '../notifications/application/outbox-dispatcher';

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
export { EmergencyTakedownService } from '../cms/application/emergency-takedown.service';
export {
  TravelTimeService,
  ROUTES_ENABLED,
  type TravelTarget,
} from '../suggestions/application/travel-time.service';
