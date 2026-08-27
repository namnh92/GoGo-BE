import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG, type IdentityConfig } from '../../shared/config';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { AuthService, type ClientMeta } from '../application/auth.service';
import { REFRESH_COOKIE } from './auth.guard';
import { clearAuthCookies, setAuthCookies } from './cookies';
import { Public, RateLimit } from './decorators';
import {
  loginSchema,
  refreshSchema,
  registerSchema,
  type LoginDto,
  type RefreshDto,
  type RegisterDto,
} from './dtos';

type CookieRequest = FastifyRequest & { cookies?: Record<string, string | undefined> };

function clientMeta(req: FastifyRequest): ClientMeta {
  const ua = req.headers['user-agent'];
  return {
    ...(req.ip ? { ip: req.ip } : {}),
    ...(typeof ua === 'string' ? { userAgent: ua.slice(0, 256) } : {}),
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: IdentityConfig,
  ) {}

  @Public()
  @RateLimit({ action: 'auth.register', limit: 10, windowSeconds: 60, keyBy: 'ip' })
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.register({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      ...(body.claimGuestToken ? { claimGuestToken: body.claimGuestToken } : {}),
      meta: clientMeta(req),
    });
    setAuthCookies(reply, result.tokens, this.cookieOpts());
    return {
      userId: result.userId,
      ...(result.claimedRoomId ? { claimedRoomId: result.claimedRoomId } : {}),
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresIn: result.tokens.accessExpiresInSeconds,
    };
  }

  @Public()
  @RateLimit({ action: 'auth.login', limit: 5, windowSeconds: 60, keyBy: 'ip' })
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.login({ ...body, meta: clientMeta(req) });
    setAuthCookies(reply, result.tokens, this.cookieOpts());
    return {
      userId: result.userId,
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresIn: result.tokens.accessExpiresInSeconds,
    };
  }

  @Public()
  @RateLimit({ action: 'auth.refresh', limit: 30, windowSeconds: 60, keyBy: 'ip' })
  @Post('refresh')
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) body: RefreshDto,
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (body.guestToken) {
      const result = await this.auth.refreshGuestAccess(body.guestToken);
      setAuthCookies(reply, { accessToken: result.accessToken }, this.cookieOpts());
      return { accessToken: result.accessToken, roomId: result.roomId };
    }

    const refreshToken = body.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) {
      throw AppError.unauthorized('MISSING_REFRESH_TOKEN', 'No refresh token provided');
    }
    const tokens = await this.auth.refresh(refreshToken, clientMeta(req));
    setAuthCookies(reply, tokens, this.cookieOpts());
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.accessExpiresInSeconds,
    };
  }

  private cookieOpts() {
    return {
      secure: this.config.COOKIE_SECURE,
      accessTtlSeconds: this.config.AUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlSeconds: this.config.AUTH_REFRESH_TOKEN_TTL_SECONDS,
    };
  }
}

export { clearAuthCookies };
