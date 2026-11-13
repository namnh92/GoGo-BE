import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/app-error';
import type { InviteBootstrapOutput } from '../application/invite-attempt.service';
import { ManualIdempotency, NoIdempotencyReplay } from '../../shared/idempotency.interceptor';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import {
  InviteAttemptService,
  type InviteAttemptRequest,
} from '../application/invite-attempt.service';
import { Public } from './decorators';

export const INVITE_CONTEXT_COOKIE = '__Host-gogo_invite_ctx';
export const INVITE_CONTEXT_HEADER = 'x-gogo-invite-context';
export const INVITE_CSRF_HEADER = 'x-gogo-invite-csrf';
export const INVITE_CSRF_COOKIE = '__Host-gogo_invite_csrf';
export const inviteBootstrapSchema = z
  .object({ transport: z.enum(['MOBILE_HEADER', 'BROWSER_COOKIE']) })
  .strict();

export const inviteCsrfRecoverySchema = z.object({}).strict();

export function inviteAttemptRequest(
  req: FastifyRequest & { edgeClientIp?: string },
): InviteAttemptRequest {
  const header = (name: string) =>
    typeof req.headers[name] === 'string' ? (req.headers[name] as string) : undefined;
  return {
    ip: req.edgeClientIp ?? req.ip,
    key: header('idempotency-key'),
    headerProof: header(INVITE_CONTEXT_HEADER),
    cookieProof: req.cookies?.[INVITE_CONTEXT_COOKIE],
    csrf: header(INVITE_CSRF_HEADER),
    origin: header('origin'),
    fetchSite: header('sec-fetch-site'),
  };
}

@Controller('invite-attempt-contexts')
export class InviteAttemptController {
  constructor(private readonly attempts: InviteAttemptService) {}

  @Public()
  @NoIdempotencyReplay()
  @Post('csrf')
  @HttpCode(200)
  async recoverCsrf(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (
      !/^application\/json(?:\s*;\s*charset=[^;\s]+)?\s*$/i.test(req.headers['content-type'] ?? '')
    )
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
    // Do not normalize a missing body to {}: the empty object must be explicit.
    new ZodValidationPipe(inviteCsrfRecoverySchema).transform(body);
    const request = inviteAttemptRequest(req);
    try {
      return await this.attempts.recoverCsrf(request);
    } catch (error) {
      if (
        request.headerProof === undefined &&
        error instanceof AppError &&
        error.code === 'INVITE_CONTEXT_REQUIRED'
      )
        this.clearInviteCookies(reply);
      throw error;
    }
  }

  private clearInviteCookies(reply: FastifyReply): void {
    reply.clearCookie(INVITE_CONTEXT_COOKIE, {
      secure: true,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
    });
    reply.clearCookie(INVITE_CSRF_COOKIE, {
      secure: true,
      httpOnly: false,
      path: '/',
      sameSite: 'lax',
    });
  }

  @Public()
  @ManualIdempotency()
  @Post()
  async bootstrap(
    @Body(new ZodValidationPipe(inviteBootstrapSchema)) body: z.infer<typeof inviteBootstrapSchema>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    let result: InviteBootstrapOutput;
    try {
      result = await this.attempts.bootstrap(body.transport, inviteAttemptRequest(req));
    } catch (error) {
      // Transport cleanup only: JavaScript cannot discard an unusable HttpOnly
      // proof. Origin policy already ran in the service before a browser 401.
      if (
        body.transport === 'BROWSER_COOKIE' &&
        error instanceof AppError &&
        error.code === 'INVITE_CONTEXT_REQUIRED'
      ) {
        reply.clearCookie(INVITE_CONTEXT_COOKIE, {
          secure: true,
          httpOnly: true,
          path: '/',
          sameSite: 'lax',
        });
        reply.clearCookie(INVITE_CSRF_COOKIE, {
          secure: true,
          httpOnly: false,
          path: '/',
          sameSite: 'lax',
        });
      }
      throw error;
    }
    if (result.cookie) {
      reply.setCookie(INVITE_CONTEXT_COOKIE, result.cookie, {
        secure: true,
        httpOnly: true,
        path: '/',
        sameSite: 'lax',
        expires: new Date(result.body.expiresAt),
        maxAge: result.maxAge,
      });
      reply.setCookie(INVITE_CSRF_COOKIE, result.body.csrfToken!, {
        secure: true,
        httpOnly: false,
        path: '/',
        sameSite: 'lax',
        expires: new Date(result.body.expiresAt),
        maxAge: result.maxAge,
      });
    }
    return result.body;
  }
}
