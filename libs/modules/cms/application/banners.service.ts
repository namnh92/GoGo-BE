import { Inject, Injectable } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';
import { decodeKeysetCursor, encodeKeysetCursor, toIso } from '../../shared/cursor';
import { assertExternalUrl } from '../../shared/external-url';
import { APP_CONFIG, type MediaConfig } from '../../shared/config';
import { UploadsService } from '../../uploads/application/uploads.service';
import type { Actor } from '../../identity/domain/actor';
import type { ContentAudience } from '../../shared/audience';

/**
 * BE-CMS-G4c (#224) — banners.
 *
 * Two things here are server truth rather than client inference. The
 * destination is validated against the row it points at, so a banner cannot
 * ship pointing at a place that was deleted; and `expired` is computed from the
 * clock on every read, because a stored expiry is wrong for as long as it takes
 * something to notice — or forever, if nothing runs.
 */

export const BANNER_PLACEMENTS = ['home_hero', 'home_secondary'] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];

/** What a person sets. `expired` is not one of these; see `effectiveStatus`. */
export const BANNER_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;
export type BannerStatus = (typeof BANNER_STATUSES)[number];

/** What a reader sees, which includes the one the clock decides. */
export const BANNER_EFFECTIVE_STATUSES = [...BANNER_STATUSES, 'expired'] as const;
export type BannerEffectiveStatus = (typeof BANNER_EFFECTIVE_STATUSES)[number];

export const BANNER_DESTINATIONS = [
  'none',
  'place',
  'recommendation',
  'plan_template',
  'campaign',
  'external_url',
] as const;
export type BannerDestination = (typeof BANNER_DESTINATIONS)[number];

const STATUS_TRANSITIONS: Record<BannerStatus, BannerStatus[]> = {
  draft: ['scheduled', 'published', 'archived'],
  scheduled: ['draft', 'published', 'archived'],
  published: ['draft', 'archived'],
  archived: [],
};

/** Which table each destination points into, when it points at a row. */
const DESTINATION_TABLES: Partial<Record<BannerDestination, SQL>> = {
  place: sql`select 1 from places where id = `,
  recommendation: sql`select 1 from content_collections where kind = 'recommendation' and id = `,
  plan_template: sql`select 1 from plan_templates where id = `,
  campaign: sql`select 1 from notification_campaigns where id = `,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BannerInput = {
  name: string;
  imageKey: string;
  title?: string | undefined;
  subtitle?: string | undefined;
  ctaLabel?: string | undefined;
  destinationType?: BannerDestination | undefined;
  destinationValue?: string | undefined;
  audience?: ContentAudience | undefined;
  placement: BannerPlacement;
  startsAt?: Date | undefined;
  endsAt?: Date | undefined;
  priority?: number | undefined;
};

export type BannerPatch = { [K in keyof BannerInput]?: BannerInput[K] | undefined };

export type BannerListQuery = {
  placement?: BannerPlacement | undefined;
  status?: BannerEffectiveStatus | undefined;
  audience?: ContentAudience | undefined;
  q?: string | undefined;
  limit: number;
  cursor?: string | undefined;
};

type BannerRow = {
  id: string;
  name: string;
  image_key: string;
  title: string | null;
  subtitle: string | null;
  cta_label: string | null;
  destination_type: BannerDestination;
  destination_value: string | null;
  audience: ContentAudience | null;
  placement: BannerPlacement;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  priority: number;
  status: BannerStatus;
  created_by_admin_id: string;
  created_at: Date | string;
  updated_at: Date | string;
};

@Injectable()
export class BannersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly uploads: UploadsService,
    @Inject(APP_CONFIG) private readonly config: MediaConfig,
  ) {}

  async list(query: BannerListQuery) {
    const filters: SQL[] = [sql`true`];
    if (query.placement) filters.push(sql`b.placement = ${query.placement}`);
    if (query.audience) filters.push(sql`b.audience = ${query.audience}`);
    if (query.q) {
      const needle = `%${query.q.trim().toLowerCase()}%`;
      filters.push(
        sql`(lower(b.name) like ${needle} or lower(coalesce(b.title, '')) like ${needle})`,
      );
    }
    // `expired` is a query about the clock, not about the stored column, so it
    // is expressed here the same way it is computed on read.
    if (query.status === 'expired') {
      filters.push(sql`b.status = 'published' and b.ends_at is not null and b.ends_at <= now()`);
    } else if (query.status) {
      filters.push(sql`b.status = ${query.status}`);
      if (query.status === 'published') {
        filters.push(sql`(b.ends_at is null or b.ends_at > now())`);
      }
    }

    const countWhere = sql.join(filters, sql` and `);
    const pageFilters = [...filters];
    if (query.cursor) {
      const { at, id } = decodeKeysetCursor(query.cursor);
      pageFilters.push(sql`(b.created_at, b.id) < (${at}::timestamptz, ${id}::uuid)`);
    }

    const [page, total] = await Promise.all([
      this.db.execute(sql`
        select b.* from banners b
        where ${sql.join(pageFilters, sql` and `)}
        order by b.created_at desc, b.id desc
        limit ${query.limit + 1}
      `),
      this.db.execute(sql`select count(*)::int as n from banners b where ${countWhere}`),
    ]);

    const rows = page.rows as BannerRow[];
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

  async create(actor: Actor, input: BannerInput) {
    const destination = await this.validateDestination(
      input.destinationType ?? 'none',
      input.destinationValue,
    );
    this.assertWindow(input.startsAt, input.endsAt);

    /*
     * The insert and the attach stand or fall together.
     *
     * `attachImage` is what refuses a key belonging to another actor, an
     * expired one, or one issued for a different purpose — but the banner id
     * it binds to does not exist until the insert. Run bare, the insert
     * committed first and a rejected key returned 400 over a banner row that
     * was already there, pointing at an image nobody could ever load. The
     * transaction is what makes the refusal leave nothing behind, which is
     * what `CmsPlaceMediaService.attach` gets for free by attaching first.
     */
    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.banners)
        .values({
          name: input.name,
          imageKey: input.imageKey,
          title: input.title ?? null,
          subtitle: input.subtitle ?? null,
          ctaLabel: input.ctaLabel ?? null,
          destinationType: destination.type,
          destinationValue: destination.value,
          audience: input.audience ?? null,
          placement: input.placement,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
          priority: input.priority ?? 0,
          createdByAdminId: actor.id,
        })
        .returning({ id: schema.banners.id })
        .catch((err: unknown) => {
          throw this.nameConflict(err, input.name);
        });

      await this.attachImage(actor, inserted!.id, input.imageKey);
      return inserted!;
    });

    await this.audit(actor.id, 'banner.created', row.id, {
      name: input.name,
      placement: input.placement,
      destinationType: destination.type,
    });
    return this.get(row.id);
  }

  async update(actor: Actor, id: string, patch: BannerPatch) {
    const before = await this.requireRow(id);
    const destination = await this.validateDestination(
      patch.destinationType ?? before.destination_type,
      patch.destinationValue ?? before.destination_value ?? undefined,
    );
    this.assertWindow(
      patch.startsAt ?? (before.starts_at ? new Date(before.starts_at) : undefined),
      patch.endsAt ?? (before.ends_at ? new Date(before.ends_at) : undefined),
    );

    /*
     * Validate the replacement before writing it.
     *
     * The update used to set `imageKey` first and attach afterwards, so a
     * rejected key was already saved by the time the 400 came back: the banner
     * kept pointing at an image that had never been uploaded, and the last
     * good image was gone from the record with no way to recover it. A failed
     * replacement must leave the banner exactly as it was.
     */
    if (patch.imageKey && patch.imageKey !== before.image_key) {
      await this.attachImage(actor, id, patch.imageKey);
    }

    await this.db
      .update(schema.banners)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.imageKey !== undefined ? { imageKey: patch.imageKey } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.subtitle !== undefined ? { subtitle: patch.subtitle } : {}),
        ...(patch.ctaLabel !== undefined ? { ctaLabel: patch.ctaLabel } : {}),
        ...(patch.audience !== undefined ? { audience: patch.audience } : {}),
        ...(patch.placement !== undefined ? { placement: patch.placement } : {}),
        ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
        ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        destinationType: destination.type,
        destinationValue: destination.value,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.banners.id, id))
      .catch((err: unknown) => {
        throw this.nameConflict(err, patch.name ?? before.name);
      });

    await this.audit(actor.id, 'banner.updated', id, {
      before: {
        placement: before.placement,
        destinationType: before.destination_type,
        priority: before.priority,
      },
      after: patch,
    });
    return this.get(id);
  }

  async setStatus(adminId: string, id: string, status: BannerStatus) {
    const before = await this.requireRow(id);
    if (before.status === status) return { id, status };
    if (!STATUS_TRANSITIONS[before.status].includes(status)) {
      throw AppError.conflict(
        'INVALID_STATUS_TRANSITION',
        `A banner cannot go from ${before.status} to ${status}`,
      );
    }
    if (status === 'scheduled' && !before.starts_at) {
      throw AppError.badRequest('SCHEDULE_REQUIRED', 'Scheduling needs a start time', [
        { field: 'startsAt', code: 'required', message: 'set a start time before scheduling' },
      ]);
    }
    // Publishing something whose window has already closed would put a banner
    // on the surface that the same read then reports as expired.
    if (status === 'published' && before.ends_at && new Date(before.ends_at) <= new Date()) {
      throw AppError.badRequest('WINDOW_CLOSED', 'That banner’s window has already ended', [
        { field: 'endsAt', code: 'past', message: 'move the end time before publishing' },
      ]);
    }

    await this.db
      .update(schema.banners)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(schema.banners.id, id));
    await this.audit(adminId, 'banner.status_changed', id, {
      before: before.status,
      after: status,
    });
    return { id, status };
  }

  // ---------------------------------------------------------------- internals

  private async attachImage(actor: Actor, bannerId: string, imageKey: string): Promise<void> {
    await this.uploads.attach(actor, [imageKey], {
      type: 'banner',
      id: bannerId,
      purposes: ['banner_image'],
    });
  }

  private async validateDestination(
    type: BannerDestination,
    value: string | undefined,
  ): Promise<{ type: BannerDestination; value: string | null }> {
    if (type === 'none') {
      if (value) {
        throw AppError.badRequest('INVALID_DESTINATION', 'That destination cannot be used', [
          { field: 'destinationValue', code: 'invalid', message: 'none takes no destination' },
        ]);
      }
      return { type, value: null };
    }
    if (!value) {
      throw AppError.badRequest('INVALID_DESTINATION', 'That destination cannot be used', [
        { field: 'destinationValue', code: 'required', message: `${type} needs a destination` },
      ]);
    }
    if (type === 'external_url') {
      return { type, value: assertExternalUrl(value) };
    }
    if (!UUID.test(value)) {
      throw AppError.badRequest('INVALID_DESTINATION', 'That destination cannot be used', [
        { field: 'destinationValue', code: 'invalid', message: 'must be an id' },
      ]);
    }

    // Cross-checked against the table the type names: a banner pointing at a
    // place that does not exist is a contract error, not a rendering one — the
    // surface would show a tap that goes nowhere.
    const query = DESTINATION_TABLES[type];
    const { rows } = await this.db.execute(sql`${query!}${value}::uuid`);
    if (rows.length === 0) {
      throw AppError.badRequest('DESTINATION_NOT_FOUND', 'That destination does not exist', [
        { field: 'destinationValue', code: 'not_found', message: `${type} ${value}` },
      ]);
    }
    return { type, value };
  }

  private assertWindow(startsAt?: Date | undefined, endsAt?: Date | undefined): void {
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw AppError.badRequest('INVALID_SCHEDULE', 'The window ends before it starts', [
        { field: 'endsAt', code: 'range', message: 'endsAt must be after startsAt' },
      ]);
    }
  }

  /**
   * What the banner *is*, now.
   *
   * The stored status is what a person set; `expired` is what the clock has
   * done to it since. Computing it here is the whole reason the value is not
   * stored: a column would be stale between the moment the window closes and
   * whatever eventually noticed.
   */
  private effectiveStatus(row: BannerRow): BannerEffectiveStatus {
    if (row.status !== 'published') return row.status;
    if (row.ends_at && new Date(row.ends_at) <= new Date()) return 'expired';
    return 'published';
  }

  private toDto(row: BannerRow) {
    return {
      id: row.id,
      name: row.name,
      imageKey: row.image_key,
      // Where the image is actually readable. Null until media hosting is
      // configured, rather than a URL that would 404.
      imageUrl: this.imageUrl(row.image_key),
      title: row.title ?? undefined,
      subtitle: row.subtitle ?? undefined,
      ctaLabel: row.cta_label ?? undefined,
      destinationType: row.destination_type,
      destinationValue: row.destination_value ?? undefined,
      audience: row.audience ?? undefined,
      placement: row.placement,
      startsAt: row.starts_at ? toIso(row.starts_at) : undefined,
      endsAt: row.ends_at ? toIso(row.ends_at) : undefined,
      priority: row.priority,
      status: this.effectiveStatus(row),
      /** What a person set, as opposed to what the clock made of it. */
      lifecycleStatus: row.status,
      createdByAdminId: row.created_by_admin_id,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }

  private imageUrl(key: string): string | null {
    const base = this.config?.MEDIA_PUBLIC_BASE_URL?.replace(/\/$/, '');
    return base ? `${base}/${key.replace(/^\//, '')}` : null;
  }

  private async requireRow(id: string): Promise<BannerRow> {
    const { rows } = await this.db.execute(sql`select * from banners where id = ${id}::uuid`);
    const row = rows[0] as BannerRow | undefined;
    if (!row) throw AppError.notFound('BANNER_NOT_FOUND', 'Banner not found');
    return row;
  }

  private nameConflict(err: unknown, name: string): unknown {
    for (let cause: unknown = err; cause instanceof Error; cause = cause.cause) {
      const pg = cause as Error & { code?: string };
      if (pg.code === '23505' || pg.message.includes('banners_name_unique')) {
        return AppError.conflict('BANNER_NAME_TAKEN', `A banner named "${name}" already exists`);
      }
    }
    return err;
  }

  private audit(adminId: string, action: string, id: string, diff: unknown) {
    return writeAudit(this.db, {
      actorType: 'admin',
      actorId: adminId,
      action,
      resourceType: 'banner',
      resourceId: id,
      diff,
    });
  }
}
