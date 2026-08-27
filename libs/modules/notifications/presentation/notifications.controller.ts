import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { CurrentActor } from '../../identity/presentation/decorators';

// eslint-disable-next-line no-useless-assignment -- used in decorator below
const deviceTokenSchema = z.object({
  platform: z.enum(['ios', 'android', 'web']),
  token: z.string().min(10).max(4096),
});

function requireUser(actor: Actor): string {
  if (actor.type !== 'user') throw AppError.forbidden('USER_ONLY', 'Login required');
  return actor.id;
}

@Controller('me')
export class NotificationsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('notifications')
  async list(@CurrentActor() actor: Actor, @Query('cursor') cursor?: string) {
    const userId = requireUser(actor);
    const before = cursor ? new Date(cursor) : null;
    const rows = await this.db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, userId),
          ...(before && !Number.isNaN(before.getTime())
            ? [lt(schema.notifications.createdAt, before)]
            : []),
        ),
      )
      .orderBy(desc(schema.notifications.createdAt))
      .limit(21);
    const page = rows.slice(0, 20);
    return {
      notifications: page.map((n) => ({
        id: n.id,
        kind: n.kind,
        payload: n.payload,
        readAt: n.readAt?.toISOString(),
        createdAt: n.createdAt.toISOString(),
      })),
      nextCursor: rows.length > 20 ? page[page.length - 1]!.createdAt.toISOString() : null,
    };
  }

  @Post('notifications/:id/read')
  async markRead(
    @CurrentActor() actor: Actor,
    @Param('id', new ZodValidationPipe(z.string().uuid())) id: string,
  ) {
    const userId = requireUser(actor);
    await this.db
      .update(schema.notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, userId)));
    return { read: true };
  }

  @Put('device-tokens')
  async registerDevice(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(deviceTokenSchema))
    body: { platform: 'ios' | 'android' | 'web'; token: string },
  ) {
    const userId = requireUser(actor);
    await this.db
      .insert(schema.deviceTokens)
      .values({ userId, platform: body.platform, token: body.token })
      .onConflictDoUpdate({
        target: schema.deviceTokens.token,
        set: { userId, platform: body.platform, lastSeenAt: sql`now()` },
      });
    return { registered: true };
  }
}
