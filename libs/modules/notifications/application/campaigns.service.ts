import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { decodeKeysetCursor, encodeKeysetCursor, toIso } from '../../shared/cursor';
import {
  AUDIENCE_FILTERS,
  CAMPAIGN_TRANSITIONS,
  EDITABLE_STATUSES,
  assertDestinationShape,
  type CampaignAudience,
  type CampaignDestination,
  type CampaignStatus,
} from '../domain/campaign';
import { audiencePredicate, respectsPushPreference } from './campaign-audience';
import { UploadsService } from '../../uploads/application/uploads.service';
import type { Actor } from '../../identity/domain/actor';

/**
 * BE-CMS-G4e (#226) — campaigns, as far as the API is concerned.
 *
 * This service validates and stores. It never calls a push provider, never
 * resolves an audience for delivery, and never sends anything: a campaign that
 * has gone out cannot be recalled, so the only thing that can start one is a
 * row transition the worker picks up on its own tick. `CampaignDispatcher` is
 * the other half, and it lives in the worker process.
 */

export type CampaignInput = {
  name: string;
  title: string;
  body: string;
  imageKey?: string | undefined;
  ctaLabel?: string | undefined;
  audienceType: CampaignAudience;
  audienceFilter?: unknown;
  destinationType?: CampaignDestination | undefined;
  destinationValue?: string | undefined;
};

export type CampaignPatch = { [K in keyof CampaignInput]?: CampaignInput[K] | undefined };

export type CampaignListQuery = {
  status?: CampaignStatus | undefined;
  audienceType?: CampaignAudience | undefined;
  q?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

/**
 * Everything that reaches a phone, or decides who it reaches. `name` is absent
 * on purpose: it is the editorial label in the CMS list and no recipient ever
 * sees it, so renaming a delivered campaign stays allowed.
 */
const DELIVERED_IMMUTABLE_FIELDS = [
  'title',
  'body',
  'imageKey',
  'ctaLabel',
  'audienceType',
  'audienceFilter',
  'destinationType',
  'destinationValue',
] as const;

/** Key order must not read as a change, so objects compare by sorted keys. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/** Which of the immutable-after-delivery fields this patch would actually change. */
function changedDeliveredFields(
  before: CampaignRow,
  merged: {
    title: string;
    body: string;
    imageKey?: string | undefined;
    ctaLabel?: string | undefined;
    audienceType: CampaignAudience;
    /** Whatever the caller merged; compared structurally, never indexed. */
    audienceFilter: unknown;
    destinationType: CampaignDestination;
    destinationValue?: string | undefined;
  },
): string[] {
  const current: Record<(typeof DELIVERED_IMMUTABLE_FIELDS)[number], unknown> = {
    title: before.title,
    body: before.body,
    imageKey: before.image_key ?? undefined,
    ctaLabel: before.cta_label ?? undefined,
    audienceType: before.audience_type,
    audienceFilter: before.audience_filter,
    destinationType: before.destination_type,
    destinationValue: before.destination_value ?? undefined,
  };
  return DELIVERED_IMMUTABLE_FIELDS.filter(
    (field) => stableJson(current[field]) !== stableJson(merged[field]),
  );
}

type CampaignRow = {
  id: string;
  name: string;
  title: string;
  body: string;
  image_key: string | null;
  cta_label: string | null;
  audience_type: CampaignAudience;
  audience_filter: Record<string, unknown>;
  destination_type: CampaignDestination;
  destination_value: string | null;
  status: CampaignStatus;
  scheduled_at: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  recipient_count: number | null;
  sent_count: number;
  failed_count: number;
  last_error: string | null;
  dispatch_key: string | null;
  test_send_requested_at: Date | string | null;
  test_send_completed_at: Date | string | null;
  created_by_admin_id: string;
  created_at: Date | string;
  updated_at: Date | string;
};

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uploads: UploadsService,
  ) {}

  /*
   * BE-CMS-M2 — a campaign image is an upload like any other.
   *
   * Banners and place photos both bind their key through `uploads.attach`,
   * which is what refuses a key belonging to another actor, an expired one, or
   * one issued for a different purpose. Campaigns stored whatever string
   * arrived: the key was never checked, never claimed, and stayed `pending`
   * forever, so nothing stopped a campaign from carrying a `place_image` key —
   * or one that had never been uploaded at all.
   */
  private async attachImage(actor: Actor, campaignId: string, imageKey: string): Promise<void> {
    await this.uploads.attach(actor, [imageKey], {
      type: 'campaign',
      id: campaignId,
      purposes: ['campaign_image'],
    });
  }

  async list(query: CampaignListQuery) {
    const filters: SQL[] = [sql`true`];
    if (query.status) filters.push(sql`c.status = ${query.status}`);
    if (query.audienceType) filters.push(sql`c.audience_type = ${query.audienceType}`);
    if (query.q) {
      const needle = `%${query.q.trim().toLowerCase()}%`;
      filters.push(sql`(lower(c.name) like ${needle} or lower(c.title) like ${needle})`);
    }

    const countWhere = sql.join(filters, sql` and `);
    const pageFilters = [...filters];
    if (query.cursor) {
      const { at, id } = decodeKeysetCursor(query.cursor);
      pageFilters.push(sql`(c.created_at, c.id) < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [page, total] = await Promise.all([
      this.db.execute(sql`
        select c.* from notification_campaigns c
        where ${sql.join(pageFilters, sql` and `)}
        order by c.created_at desc, c.id desc
        limit ${query.limit + 1}
      `),
      this.db.execute(
        sql`select count(*)::int as n from notification_campaigns c where ${countWhere}`,
      ),
    ]);

    const rows = page.rows as CampaignRow[];
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((r) => this.toDto(r)),
      nextCursor:
        rows.length > query.limit && last ? encodeKeysetCursor(last.created_at, last.id) : null,
      totalCount: (total.rows[0] as { n: number }).n,
    };
  }

  async get(id: string) {
    return this.toDto(await this.requireRow(id));
  }

  async create(actor: Actor, input: CampaignInput) {
    const adminId = actor.id;
    const { audienceFilter, destinationType, destinationValue } = await this.validate(input);

    const [row] = await this.insertCampaign(actor, input, {
      audienceFilter,
      destinationType,
      destinationValue,
      adminId,
    });
    return this.afterCreate(adminId, row!.id, input, destinationType);
  }

  private async insertCampaign(
    actor: Actor,
    input: CampaignInput,
    ctx: {
      audienceFilter: Record<string, unknown>;
      destinationType: CampaignDestination;
      destinationValue: string | null;
      adminId: string;
    },
  ) {
    /*
     * Insert and attach stand or fall together, as they do for a banner: the
     * campaign id the key binds to does not exist until the insert, so a
     * rejected key has to take the row with it.
     */
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(schema.notificationCampaigns)
        .values({
          name: input.name,
          title: input.title,
          body: input.body,
          imageKey: input.imageKey ?? null,
          ctaLabel: input.ctaLabel ?? null,
          audienceType: input.audienceType,
          audienceFilter: ctx.audienceFilter,
          destinationType: ctx.destinationType,
          destinationValue: ctx.destinationValue,
          createdByAdminId: ctx.adminId,
        })
        .returning({ id: schema.notificationCampaigns.id })
        .catch((err: unknown) => {
          throw this.nameConflict(err, input.name);
        });

      if (input.imageKey) await this.attachImage(actor, rows[0]!.id, input.imageKey);
      return rows;
    });
  }

  private async afterCreate(
    adminId: string,
    id: string,
    input: CampaignInput,
    destinationType: CampaignDestination,
  ) {
    await this.audit(adminId, 'campaign.created', id, {
      name: input.name,
      audienceType: input.audienceType,
      destinationType,
    });
    return this.get(id);
  }

  async update(actor: Actor, id: string, patch: CampaignPatch) {
    const adminId = actor.id;
    const before = await this.requireRow(id);
    if (!EDITABLE_STATUSES.includes(before.status)) {
      // Editing a scheduled campaign silently changes what is about to go out.
      // Unschedule it first: that is a deliberate act, and it is auditable.
      throw AppError.conflict(
        'CAMPAIGN_NOT_EDITABLE',
        `A campaign in ${before.status} cannot be edited`,
      );
    }

    const merged = {
      name: patch.name ?? before.name,
      title: patch.title ?? before.title,
      body: patch.body ?? before.body,
      audienceType: patch.audienceType ?? before.audience_type,
      audienceFilter: patch.audienceFilter ?? before.audience_filter,
      destinationType: patch.destinationType ?? before.destination_type,
      destinationValue: patch.destinationValue ?? before.destination_value ?? undefined,
      imageKey: patch.imageKey ?? before.image_key ?? undefined,
      ctaLabel: patch.ctaLabel ?? before.cta_label ?? undefined,
    };
    // Review finding R3: a campaign that has delivered to anyone can no longer
    // have its message changed.
    //
    // `failed` and `cancelled` are editable, and a failed campaign is resumed
    // under its existing dispatch key so the recipients it already reached are
    // skipped. Editing the copy in that state would send the new text to the
    // remainder only — half an audience holding one message, half another, with
    // nothing recording the split. Cancelling first does not help either: that
    // mints a fresh key, so the already-delivered recipients receive a second,
    // different message.
    //
    // Neither is a thing an operator can undo, so the edit is refused and the
    // new message becomes a new campaign. What stays allowed is the editorial
    // `name` (it never reaches a phone) and a retry of the unchanged campaign.
    const changed = changedDeliveredFields(before, merged);
    if (changed.length > 0) {
      const delivered = await this.deliveredRecipients(id);
      if (delivered > 0) {
        throw AppError.conflict(
          'CAMPAIGN_ALREADY_DELIVERED',
          `This campaign has already been delivered to ${delivered} recipient(s), so ${changed.join(', ')} can no longer be changed. Retry it as it stands, or create a new campaign for the new message.`,
        );
      }
    }

    const validated = await this.validate(merged);

    /*
     * Same order as a banner: the replacement is validated before it is
     * written, so a rejected key leaves the campaign pointing at the image it
     * already had rather than at one that was never uploaded.
     */
    if (patch.imageKey && patch.imageKey !== before.image_key) {
      await this.attachImage(actor, id, patch.imageKey);
    }

    await this.db
      .update(schema.notificationCampaigns)
      .set({
        name: merged.name,
        title: merged.title,
        body: merged.body,
        imageKey: merged.imageKey ?? null,
        ctaLabel: merged.ctaLabel ?? null,
        audienceType: merged.audienceType,
        audienceFilter: validated.audienceFilter,
        destinationType: validated.destinationType,
        destinationValue: validated.destinationValue,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.notificationCampaigns.id, id))
      .catch((err: unknown) => {
        throw this.nameConflict(err, merged.name);
      });

    await this.audit(adminId, 'campaign.updated', id, {
      before: {
        title: before.title,
        audienceType: before.audience_type,
        destinationType: before.destination_type,
      },
      after: { title: merged.title, audienceType: merged.audienceType },
    });
    return this.get(id);
  }

  /**
   * Hands the campaign to the worker.
   *
   * `sendAt` in the past — or omitted, which is "send now" — becomes a due
   * campaign the next tick picks up. Nothing is delivered from here: the
   * request returns before a single message exists.
   */
  async schedule(adminId: string, id: string, sendAt?: Date | undefined) {
    const before = await this.requireRow(id);
    this.assertTransition(before.status, 'scheduled');

    // Re-validated at the last editable moment: the referenced place or
    // recommendation may have been deleted since the draft was written.
    await this.validate({
      audienceType: before.audience_type,
      audienceFilter: before.audience_filter,
      destinationType: before.destination_type,
      destinationValue: before.destination_value ?? undefined,
    });

    const scheduledAt = sendAt ?? new Date();
    // Review fix (#193): a campaign that *failed* mid-send is resumed, not
    // re-sent. Keeping its dispatch key keeps every recipient's dedupe key, so
    // the worker skips the ones whose row says the push went through and
    // retries the rest. Only a deliberate re-send — cancel, then schedule
    // again, which nulls the key — mints a new one and reaches everyone anew.
    const dispatchKey =
      before.status === 'failed' && before.dispatch_key ? before.dispatch_key : randomUUID();
    await this.db
      .update(schema.notificationCampaigns)
      .set({
        status: 'scheduled',
        scheduledAt,
        dispatchKey,
        sentCount: 0,
        failedCount: 0,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.notificationCampaigns.id, id));

    await this.audit(adminId, 'campaign.scheduled', id, {
      scheduledAt: scheduledAt.toISOString(),
      audienceType: before.audience_type,
      dispatchKey,
    });
    return this.get(id);
  }

  /**
   * Cancels a campaign that has not started.
   *
   * Once the worker is in `sending`, some messages are already on phones and
   * there is nothing to recall — so this refuses rather than reporting a
   * cancellation the backend cannot perform, and says how far the send got.
   */
  async cancel(adminId: string, id: string) {
    const before = await this.requireRow(id);
    if (before.status === 'sending') {
      throw AppError.conflict(
        'CAMPAIGN_ALREADY_SENDING',
        `Sending has started: ${before.sent_count} of ${before.recipient_count ?? '?'} delivered. ` +
          'Messages already handed to the provider cannot be recalled.',
      );
    }
    this.assertTransition(before.status, 'cancelled');

    await this.db
      .update(schema.notificationCampaigns)
      .set({
        status: 'cancelled',
        cancelledByAdminId: adminId,
        scheduledAt: null,
        dispatchKey: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.notificationCampaigns.id, id),
          // Guards the race with the worker's claim: if it flipped the row to
          // `sending` between the read and this write, nothing is updated.
          eq(schema.notificationCampaigns.status, 'scheduled'),
        ),
      );

    const after = await this.requireRow(id);
    if (after.status !== 'cancelled') {
      throw AppError.conflict(
        'CAMPAIGN_ALREADY_SENDING',
        'Sending started while the cancellation was being processed',
      );
    }
    await this.audit(adminId, 'campaign.cancelled', id, { from: before.status });
    return this.toDto(after);
  }

  /**
   * How many people this would reach, right now.
   *
   * A read with no side effect and no row written — the point is to see the
   * size of a send before committing to one that cannot be undone. The number
   * is a snapshot: the audience is resolved again at send time, so it can move.
   */
  async estimateAudience(id: string) {
    const row = await this.requireRow(id);
    const predicate = audiencePredicate(row.audience_type, row.audience_filter);
    // NTF-BE-013 (#523): the same two clauses the worker resolves with, in the
    // same order. The estimate used to apply only the audience predicate, so
    // the number shown immediately before an action that cannot be recalled
    // counted every person who had turned campaign push off — and the send
    // then quietly reached fewer, with nothing saying where the difference
    // went. The header of `campaign-audience.ts` promises one definition used
    // by both; this is the line that was making that untrue.
    const preference = respectsPushPreference();
    const { rows } = await this.db.execute(sql`
      select count(distinct u.id)::int as n from users u
      where ${predicate} and ${preference}
    `);
    return {
      campaignId: id,
      audienceType: row.audience_type,
      estimatedRecipients: (rows[0] as { n: number }).n,
      estimatedAt: new Date().toISOString(),
    };
  }

  /**
   * Asks the worker to deliver one copy to the composer's own account.
   *
   * Separate from a real send in every way that matters: it never changes
   * `status`, it reaches exactly one account, and that account is the admin's
   * own — matched on a verified email, so this cannot be used to push a message
   * at somebody else.
   */
  async requestTestSend(adminId: string, id: string) {
    const row = await this.requireRow(id);

    const [admin] = await this.db
      .select({ email: schema.adminUsers.email })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, adminId))
      .limit(1);

    const [self] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          sql`lower(${schema.users.email}) = ${admin?.email?.toLowerCase() ?? ''}`,
          sql`${schema.users.emailVerifiedAt} is not null`,
          sql`${schema.users.status} <> 'deleted'`,
        ),
      )
      .limit(1);

    if (!self) {
      throw AppError.badRequest(
        'NO_TEST_RECIPIENT',
        'A test send goes to your own account: register the app with this staff address and verify it',
      );
    }

    await this.db
      .update(schema.notificationCampaigns)
      .set({
        testSendRequestedAt: sql`now()`,
        testSendUserId: self.id,
        testSendCompletedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.notificationCampaigns.id, id));

    await this.audit(adminId, 'campaign.test_send_requested', id, { recipientUserId: self.id });
    return { campaignId: id, status: row.status, testSendQueued: true };
  }

  // ---------------------------------------------------------------- internals

  private async validate(input: {
    audienceType: CampaignAudience;
    audienceFilter?: unknown;
    destinationType?: CampaignDestination | undefined;
    destinationValue?: string | undefined;
  }) {
    const parsed = AUDIENCE_FILTERS[input.audienceType].safeParse(input.audienceFilter ?? {});
    if (!parsed.success) {
      throw AppError.badRequest('INVALID_AUDIENCE', 'That audience filter does not fit', [
        ...parsed.error.issues.slice(0, 5).map((issue) => ({
          field: `audienceFilter.${issue.path.join('.') || '_'}`,
          code: issue.code,
          message: issue.message,
        })),
      ]);
    }

    const destinationType = input.destinationType ?? 'home';
    const destinationValue = assertDestinationShape(destinationType, input.destinationValue);
    await this.assertDestinationExists(destinationType, destinationValue);

    return {
      audienceFilter: parsed.data as Record<string, unknown>,
      destinationType,
      destinationValue,
    };
  }

  /**
   * A deep link into content that does not exist is a dead notification on tens
   * of thousands of phones, and no amount of client handling makes it not dead.
   */
  private async assertDestinationExists(
    type: CampaignDestination,
    value: string | null,
  ): Promise<void> {
    if (!value) return;
    const exists = async (query: SQL): Promise<boolean> => {
      const { rows } = await this.db.execute(query);
      return rows.length > 0;
    };

    const found =
      type === 'place'
        ? await exists(sql`select 1 from places where id = ${value}::uuid`)
        : type === 'recommendation'
          ? await exists(
              sql`select 1 from content_collections
                  where id = ${value}::uuid and kind = 'recommendation'`,
            )
          : type === 'plan_template'
            ? await exists(sql`select 1 from plan_templates where id = ${value}::uuid`)
            : true;

    if (!found) {
      throw AppError.badRequest('DESTINATION_NOT_FOUND', 'That destination does not exist', [
        { field: 'destinationValue', code: 'not_found', message: `${type} ${value}` },
      ]);
    }
  }

  private assertTransition(from: CampaignStatus, to: CampaignStatus): void {
    if (!CAMPAIGN_TRANSITIONS[from].includes(to)) {
      throw AppError.conflict(
        'INVALID_STATUS_TRANSITION',
        `A campaign cannot go from ${from} to ${to}`,
      );
    }
  }

  private toDto(row: CampaignRow) {
    return {
      id: row.id,
      name: row.name,
      title: row.title,
      body: row.body,
      imageKey: row.image_key ?? undefined,
      ctaLabel: row.cta_label ?? undefined,
      audienceType: row.audience_type,
      audienceFilter: row.audience_filter,
      destinationType: row.destination_type,
      destinationValue: row.destination_value ?? undefined,
      status: row.status,
      scheduledAt: row.scheduled_at ? toIso(row.scheduled_at) : undefined,
      startedAt: row.started_at ? toIso(row.started_at) : undefined,
      completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
      // Delivery facts, not a promise: `sentCount` is how many the provider
      // accepted, which is not the same as how many were shown to a person.
      recipientCount: row.recipient_count ?? undefined,
      sentCount: row.sent_count,
      failedCount: row.failed_count,
      lastError: row.last_error ?? undefined,
      testSendRequestedAt: row.test_send_requested_at
        ? toIso(row.test_send_requested_at)
        : undefined,
      testSendCompletedAt: row.test_send_completed_at
        ? toIso(row.test_send_completed_at)
        : undefined,
      createdByAdminId: row.created_by_admin_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  /**
   * How many people this campaign has actually put a push on a phone for —
   * across every dispatch of it, not just the current one, because a recipient
   * reached under an earlier dispatch key holds that message just the same.
   *
   * Admin-frequency: one count on an edit, never on a send path.
   */
  private async deliveredRecipients(id: string): Promise<number> {
    const { rows } = await this.db.execute(sql`
      select count(*)::int as delivered
      from notifications
      where kind = 'campaign'
        and payload->>'campaignId' = ${id}
        and push_sent_at is not null
    `);
    return Number((rows[0] as { delivered: number }).delivered);
  }

  private async requireRow(id: string): Promise<CampaignRow> {
    const { rows } = await this.db.execute(
      sql`select * from notification_campaigns where id = ${id}::uuid`,
    );
    const row = rows[0] as CampaignRow | undefined;
    if (!row) throw AppError.notFound('CAMPAIGN_NOT_FOUND', 'Campaign not found');
    return row;
  }

  private nameConflict(err: unknown, name: string): unknown {
    for (let cause: unknown = err; cause instanceof Error; cause = cause.cause) {
      const pg = cause as Error & { code?: string };
      if (pg.code === '23505' || pg.message.includes('notification_campaigns_name_unique')) {
        return AppError.conflict('CAMPAIGN_NAME_TAKEN', `A campaign named "${name}" exists`);
      }
    }
    return err;
  }

  private audit(adminId: string, action: string, id: string, diff: unknown) {
    return writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType: 'notification_campaign',
      resourceId: id,
      diff,
    });
  }
}
