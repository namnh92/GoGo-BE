import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ManualIdempotency } from '../../shared/idempotency.interceptor';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { PasswordRecoveryService } from '../application/password-recovery.service';
import { Public } from './decorators';
import {
  recoveryCompleteSchema,
  recoveryRequestSchema,
  type RecoveryCompleteDto,
  type RecoveryRequestDto,
} from './dtos';

@Controller('auth/password-recovery')
export class PasswordRecoveryController {
  constructor(private readonly recovery: PasswordRecoveryService) {}

  @Public()
  @ManualIdempotency()
  @Post('request')
  @HttpCode(202)
  request(
    @Body(new ZodValidationPipe(recoveryRequestSchema)) body: RecoveryRequestDto,
    @Req() req: FastifyRequest,
  ) {
    return this.recovery.request(body, this.context(req));
  }

  @Public()
  @ManualIdempotency()
  @Post('complete')
  @HttpCode(204)
  complete(
    @Body(new ZodValidationPipe(recoveryCompleteSchema)) body: RecoveryCompleteDto,
    @Req() req: FastifyRequest,
  ) {
    return this.recovery.complete(body, this.context(req));
  }

  private context(req: FastifyRequest) {
    const key = req.headers['idempotency-key'];
    return { ip: req.ip, ...(typeof key === 'string' ? { key } : {}) };
  }
}
