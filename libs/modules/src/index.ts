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
