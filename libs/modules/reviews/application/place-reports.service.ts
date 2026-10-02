import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { READABLE_PLACE_STATUSES } from '../domain/public-review';
import type { PlaceReportBody } from '../domain/place-report';

export type PlaceReportFact = {
  id: string;
  placeId: string;
  reasonCode: string;
  status: 'open' | 'actioned' | 'dismissed';
  createdAt: string;
};

/**
 * BE-BFF-P2 (#218) — "Báo thông tin sai" on Place Detail.
 *
 * Writes into the `reports` table the CMS moderation queue already reads
 * (`GET /cms/moderation/reports`, BE-CMS-G1 #219); there is no second queue.
 * Decisions stay with `CmsOpsService`.
 *
 * Who: an account or a room guest — the two actors the queue already models
 * (`reporterKind: user | guest`). A CMS admin reports nothing here; the console
 * has its own tools. Anonymous callers are refused by the global auth guard,
 * which is also what makes the per-actor rate limit meaningful.
 *
 * Privacy: the note is free text the reporter typed; it is stored for the
 * moderator and never logged or echoed back. The guest session id is internal
 * and the CMS projection already withholds it.
 */
@Injectable()
export class PlaceReportsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * `created: false` when this actor already has an **open** report of the
   * same reason on the same place: a double tap, a retry after a dropped
   * response, or someone pressing the button twice files one report, not a
   * pile the moderator has to dismiss one by one. Once decided, a new report
   * is a new report — the place may have regressed.
   *
   * Serialized per place (GoGo-BE#662 F-01): the place row is read
   * `FOR NO KEY UPDATE`, so a second submission waits for the first
   * transaction to commit and then sees its report. Without it a double tap
   * filed two rows. `NO KEY` on purpose (F-04): plain `FOR UPDATE` conflicts
   * with the `FOR KEY SHARE` lock every insert or update of a row referencing
   * `places.id` takes, so reviews, room places and plan stops for this place
   * would queue behind a report. `NO KEY UPDATE` still conflicts with itself
   * (serializing reports) and with other updates of the place row, but not
   * with foreign-key checks. Held for one select and one insert.
   */
  async file(
    actor: Actor,
    placeId: string,
    body: PlaceReportBody,
  ): Promise<{ created: boolean; report: PlaceReportFact }> {
    if (actor.type !== 'user' && actor.type !== 'guest') {
      throw AppError.forbidden('REPORTER_NOT_ALLOWED', 'Only app users and guests can report');
    }
    const reporter =
      actor.type === 'user'
        ? { reporterUserId: actor.id, reporterGuestSessionId: null }
        : { reporterUserId: null, reporterGuestSessionId: actor.id };

    return this.db.transaction(async (tx) => {
      const [place] = await tx
        .select({ id: schema.places.id })
        .from(schema.places)
        .where(
          and(
            eq(schema.places.id, placeId),
            inArray(schema.places.status, READABLE_PLACE_STATUSES),
          ),
        )
        .limit(1)
        .for('no key update');
      if (!place) throw AppError.notFound('PLACE_NOT_FOUND', 'Place not found');

      const reporterMatch =
        actor.type === 'user'
          ? and(
              eq(schema.reports.reporterUserId, actor.id),
              isNull(schema.reports.reporterGuestSessionId),
            )
          : and(
              eq(schema.reports.reporterGuestSessionId, actor.id),
              isNull(schema.reports.reporterUserId),
            );

      const [existing] = await tx
        .select()
        .from(schema.reports)
        .where(
          and(
            eq(schema.reports.targetType, 'place'),
            eq(schema.reports.targetId, placeId),
            eq(schema.reports.reasonCode, body.reasonCode),
            eq(schema.reports.status, 'open'),
            reporterMatch,
          ),
        )
        .orderBy(desc(schema.reports.createdAt))
        .limit(1);
      if (existing) return { created: false, report: toFact(existing) };

      const [row] = await tx
        .insert(schema.reports)
        .values({
          ...reporter,
          targetType: 'place',
          targetId: placeId,
          reasonCode: body.reasonCode,
          note: body.note ?? null,
        })
        .returning();
      return { created: true, report: toFact(row!) };
    });
  }
}

function toFact(row: typeof schema.reports.$inferSelect): PlaceReportFact {
  return {
    id: row.id,
    placeId: row.targetId,
    reasonCode: row.reasonCode,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
