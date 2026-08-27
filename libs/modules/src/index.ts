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

// Platform
export { writeOutbox, type DomainEventInput } from '../shared/outbox';
