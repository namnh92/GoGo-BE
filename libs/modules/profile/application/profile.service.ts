import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { writeAudit } from '../../shared/audit';
import { APP_CONFIG, type MediaConfig } from '../../shared/config';
import { assertValidSelections } from '../../shared/taxonomy-selections';
import { DB } from '../../shared/tokens';
import type { Actor } from '../../identity/domain/actor';
import { AVATAR_STORAGE_CONFIGURED } from '../../uploads/application/tokens';

/**
 * ADR-0022 — the taxonomy kinds a profile may hold. `mood` is the one kind a
 * room preference screen edits today; dietary and accessibility are room
 * constraints, not member preferences, and an interest nothing reads is
 * personal data stored for no one.
 */
export const PROFILE_INTEREST_KINDS = ['mood'] as const;

export type ProfileInterests = { mood: string[] };

export type UserProfile = {
  actorType: 'user';
  id: string;
  displayName: string;
  email?: string;
  locale: string;
  /** Composed from MEDIA_PUBLIC_BASE_URL; null while that base is empty. */
  avatarUrl: string | null;
  homeArea: { key: string; name: string; city: string | null } | null;
  interests: ProfileInterests;
  /** Integer minor units, per person. A create-room default, never a constraint. */
  usualBudget: { perPerson: number; currency: string } | null;
  capabilities: { avatarUpload: 'available' | 'unavailable' };
};

/**
 * `undefined` keeps a field, `null` clears it. `displayName` and `locale`
 * cannot be cleared; the DTO refuses null for them before this is reached.
 */
export type ProfilePatch = {
  displayName?: string | undefined;
  locale?: 'vi' | 'en' | undefined;
  homeAreaKey?: string | null | undefined;
  interests?: ProfileInterests | null | undefined;
  usualBudget?: { perPerson: number; currency: string } | null | undefined;
};

function requireUser(actor: Actor): string {
  if (actor.type !== 'user') {
    throw AppError.forbidden('USER_ONLY', 'Register an account to use this feature');
  }
  return actor.id;
}

type ProfileRow = {
  user: typeof schema.users.$inferSelect;
  area: { key: string; name: string; city: string | null } | null;
  selections: Record<string, string[]> | null;
};

/**
 * PROF-BE-002 (#532) — the profile's read and write path, one module.
 *
 * `GET /me` used to answer from identity and `PATCH /me` from the reviews
 * module, and the update spread truthy values only, so a field could never be
 * cleared. Here a patch distinguishes omitted from null, every optional field
 * is clearable, and the row is composed the same way for both verbs.
 */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: MediaConfig,
    @Inject(AVATAR_STORAGE_CONFIGURED) private readonly avatarConfigured: boolean,
  ) {}

  /**
   * Where a public object is readable, or null when media hosting is not
   * configured here. Mirrors `CmsPlaceMediaService.readUrl`: an honest null
   * beats a URL that would 404, and a client falls back to initials.
   */
  avatarUrl(key: string | null | undefined): string | null {
    const base = this.config.MEDIA_PUBLIC_BASE_URL?.replace(/\/$/, '');
    return base && key ? `${base}/${key.replace(/^\//, '')}` : null;
  }

  async getProfile(actor: Actor): Promise<UserProfile> {
    const userId = requireUser(actor);
    const row = await this.load(userId);
    if (!row) throw AppError.unauthorized('ACCOUNT_UNAVAILABLE', 'Account is not available');
    return this.toDto(row);
  }

  async updateProfile(actor: Actor, patch: ProfilePatch): Promise<UserProfile> {
    const userId = requireUser(actor);
    const fields = (Object.keys(patch) as (keyof ProfilePatch)[]).filter(
      (k) => patch[k] !== undefined,
    );
    if (fields.length === 0) return this.getProfile(actor);

    // Both checks read outside the transaction: neither depends on the row
    // being locked, and a rejected patch should not have taken a lock at all.
    if (patch.homeAreaKey) {
      const [area] = await this.db
        .select({ key: schema.serviceAreas.key })
        .from(schema.serviceAreas)
        .where(
          and(
            eq(schema.serviceAreas.key, patch.homeAreaKey),
            eq(schema.serviceAreas.isActive, true),
          ),
        )
        .limit(1);
      if (!area) {
        throw AppError.badRequest('INVALID_AREA_KEY', 'Unknown area', [
          { field: 'homeAreaKey', code: 'unknown_key', message: 'not an active service area' },
        ]);
      }
    }
    if (patch.interests) {
      await assertValidSelections(this.db, patch.interests, PROFILE_INTEREST_KINDS);
    }

    await this.db.transaction(async (tx) => {
      const set: PgUpdateSetSource<typeof schema.users> = { updatedAt: sql`now()` };
      if (patch.displayName !== undefined) set.displayName = patch.displayName;
      if (patch.locale !== undefined) set.locale = patch.locale;
      if (patch.homeAreaKey !== undefined) set.homeAreaKey = patch.homeAreaKey;
      if (patch.usualBudget !== undefined) {
        set.usualBudgetPerPerson = patch.usualBudget?.perPerson ?? null;
        set.usualBudgetCurrency = patch.usualBudget?.currency ?? 'VND';
      }
      const updated = await tx
        .update(schema.users)
        .set(set)
        .where(and(eq(schema.users.id, userId), eq(schema.users.status, 'active')))
        .returning({ id: schema.users.id });
      if (updated.length === 0) {
        throw AppError.unauthorized('ACCOUNT_UNAVAILABLE', 'Account is not available');
      }

      if (patch.interests !== undefined) {
        if (patch.interests === null) {
          await tx
            .delete(schema.userProfilePreferences)
            .where(eq(schema.userProfilePreferences.userId, userId));
        } else {
          await tx
            .insert(schema.userProfilePreferences)
            .values({ userId, selections: patch.interests })
            .onConflictDoUpdate({
              target: schema.userProfilePreferences.userId,
              set: { selections: patch.interests, updatedAt: sql`now()` },
            });
        }
      }

      // Field names only. The values are the person's own data and an audit
      // row is read by staff; "which fields moved" is the accountable fact.
      await writeAudit(tx, {
        actorType: 'user',
        actorId: userId,
        action: 'user.profile_updated',
        resourceType: 'user',
        resourceId: userId,
        diff: { fields },
      });
    });

    return this.getProfile(actor);
  }

  private async load(userId: string): Promise<ProfileRow | undefined> {
    const [row] = await this.db
      .select({
        user: schema.users,
        area: {
          key: schema.serviceAreas.key,
          name: schema.serviceAreas.name,
          city: schema.serviceAreas.city,
        },
        selections: schema.userProfilePreferences.selections,
      })
      .from(schema.users)
      .leftJoin(schema.serviceAreas, eq(schema.serviceAreas.key, schema.users.homeAreaKey))
      .leftJoin(
        schema.userProfilePreferences,
        eq(schema.userProfilePreferences.userId, schema.users.id),
      )
      .where(eq(schema.users.id, userId))
      .limit(1);
    return row;
  }

  private toDto(row: ProfileRow): UserProfile {
    const { user, area, selections } = row;
    return {
      actorType: 'user',
      id: user.id,
      displayName: user.displayName,
      ...(user.email ? { email: user.email } : {}),
      locale: user.locale,
      avatarUrl: this.avatarUrl(user.avatarKey),
      homeArea: area ? { key: area.key, name: area.name, city: area.city } : null,
      interests: { mood: selections?.mood ?? [] },
      usualBudget:
        user.usualBudgetPerPerson === null
          ? null
          : { perPerson: user.usualBudgetPerPerson, currency: user.usualBudgetCurrency },
      capabilities: { avatarUpload: this.avatarConfigured ? 'available' : 'unavailable' },
    };
  }
}
