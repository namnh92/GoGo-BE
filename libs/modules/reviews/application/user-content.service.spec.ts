import { describe, expect, it } from 'vitest';
import { schema, type Db } from '@gogo/database';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  activePlanRoomFactsQuery,
  placeNameProvenanceQuery,
  toMyReview,
  toSavedPlanConditionFacts,
  UserContentService,
} from './user-content.service';

const user = {
  type: 'user',
  id: 'a3f1c2d4-0000-4000-8000-000000000001',
  sessionId: 'session-1',
} as const;
const reviewId = '0f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';

function serviceFor(row: { id: string; userId: string; rating: number; status: 'pending' }) {
  const db = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) =>
        table === schema.reviews
          ? { returning: async () => [{ ...row, ...values }] }
          : Promise.resolve(),
    }),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [row] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({ returning: async () => [{ ...row, ...values }] }),
      }),
    }),
  };
  return new UserContentService(db as never, {} as never, {} as never, null);
}

function serviceForMyReviews(
  reviewRows: unknown[],
  roomFactRows: unknown[],
  nameProvenanceRows: unknown[] = [],
) {
  let selectCount = 0;
  const db = {
    select: (fields?: Record<string, unknown>) => {
      selectCount += 1;
      const nameProvenanceQuery = fields !== undefined && 'sourceType' in fields;
      const roomFactsQuery = fields !== undefined && 'planTitle' in fields;
      const reviewQuery = !nameProvenanceQuery && !roomFactsQuery;
      const query = {
        from: () => query,
        leftJoin: () => query,
        innerJoin: () => query,
        where: () =>
          reviewQuery
            ? query
            : Promise.resolve(nameProvenanceQuery ? nameProvenanceRows : roomFactRows),
        orderBy: () => Promise.resolve(reviewRows),
      };
      return query;
    },
  };
  return {
    service: new UserContentService(db as never, {} as never, {} as never, null),
    selectCount: () => selectCount,
  };
}

describe('UserContentService review mutation responses (#751)', () => {
  it('returns the stored rating when a review is created', async () => {
    const service = serviceFor({ id: reviewId, userId: user.id, rating: 5, status: 'pending' });

    await expect(service.createReview(user, { planId: reviewId, rating: 5 })).resolves.toEqual({
      id: reviewId,
      rating: 5,
      status: 'pending',
    });
  });

  it('returns the current rating when an edit does not change it', async () => {
    const service = serviceFor({ id: reviewId, userId: user.id, rating: 4, status: 'pending' });

    await expect(service.updateReview(user, reviewId, { text: 'Vẫn rất ổn' })).resolves.toEqual({
      id: reviewId,
      rating: 4,
      status: 'pending',
    });
  });
});

describe('own review list facts (#752)', () => {
  const base = {
    id: reviewId,
    placeId: null,
    planId: null,
    rating: 4,
    text: 'Một buổi tối vui',
    status: 'published' as const,
    moderationReason: null,
    createdAt: new Date('2026-11-05T10:00:00.000Z'),
    placeName: null,
    placeAddressText: null,
    addressSourceType: null,
    addressSourceReference: null,
    addressCollectedAt: null,
    helpfulCount: 2,
  };

  it('returns independently sourced place facts, helpful count and rejection reason', () => {
    expect(
      toMyReview(
        {
          ...base,
          placeId: '2f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
          status: 'rejected',
          moderationReason: 'Nội dung không liên quan đến địa điểm',
          placeName: 'Nhà hàng Mùa Hè',
          placeAddressText: '12 Nguyễn Huệ, Quận 1',
          addressSourceType: 'editorial',
          addressSourceReference: 'Biên bản xác nhận của chủ quán ngày 2026-11-01',
          addressCollectedAt: new Date('2026-11-01T03:00:00.000Z'),
          helpfulCount: 3,
        },
        undefined,
        {
          placeId: '2f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
          sourceType: 'editorial',
          sourceReference: 'Website chính thức của nhà hàng',
        },
      ),
    ).toMatchObject({
      placeName: 'Nhà hàng Mùa Hè',
      placeAddressText: '12 Nguyễn Huệ, Quận 1',
      helpfulCount: 3,
      rejectionReason: 'Nội dung không liên quan đến địa điểm',
    });
  });

  it.each([
    ['Google-derived', 'google_derived', 'ChIJN1t_tDeuEmsRUsoyG83frY4'],
    ['unknown-source', 'editorial', null],
    ['missing-provenance', undefined, undefined],
  ])('omits a %s place name', (_case, sourceType, sourceReference) => {
    const placeId = '2f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';
    const result = toMyReview(
      { ...base, placeId, placeName: 'Tên chưa thuộc GoGo' },
      undefined,
      sourceType ? { placeId, sourceType, sourceReference: sourceReference ?? null } : undefined,
    );

    expect(result).not.toHaveProperty('placeName');
  });

  it('returns room title/date only when the active-membership batch authorizes them', () => {
    const result = toMyReview(
      {
        ...base,
        planId: '3f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
        placeAddressText: 'Địa chỉ cũ không rõ nguồn',
      },
      {
        planTitle: 'Kỷ niệm hai năm',
        planScheduledDate: new Date('2026-11-08T12:30:00.000Z'),
      },
    );

    expect(result).toMatchObject({
      planTitle: 'Kỷ niệm hai năm',
      planScheduledDate: '2026-11-08T12:30:00.000Z',
      helpfulCount: 2,
    });
    expect(result).not.toHaveProperty('placeAddressText');
    expect(result).not.toHaveProperty('rejectionReason');
  });

  it.each(['non-member', 'removed member'])('keeps a %s review but omits room facts', async () => {
    const { service, selectCount } = serviceForMyReviews(
      [
        {
          ...base,
          planId: '3f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
        },
      ],
      [],
    );

    const [result] = await service.myReviews(user);

    expect(result).toMatchObject({
      id: reviewId,
      planId: '3f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
      rating: 4,
    });
    expect(result).not.toHaveProperty('planTitle');
    expect(result).not.toHaveProperty('planScheduledDate');
    expect(selectCount()).toBe(2);
  });

  it('returns a place name only when its batched provenance is independent', async () => {
    const placeId = '2f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d';
    const { service, selectCount } = serviceForMyReviews(
      [{ ...base, placeId, placeName: 'Nhà hàng Mùa Hè' }],
      [],
      [
        {
          placeId,
          sourceType: 'editorial',
          sourceReference: 'Website chính thức của nhà hàng',
        },
      ],
    );

    await expect(service.myReviews(user)).resolves.toEqual([
      expect.objectContaining({ id: reviewId, placeId, placeName: 'Nhà hàng Mùa Hè' }),
    ]);
    expect(selectCount()).toBe(2);
  });

  it('uses one batched predicate that excludes removed members', () => {
    const planIds = [
      '3f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
      '4f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
    ];
    const query = activePlanRoomFactsQuery(
      drizzle.mock({ schema }) as unknown as Db,
      user.id,
      planIds,
    ).toSQL();

    expect(query.sql).toContain('inner join "room_members"');
    expect(query.sql).toContain('"room_members"."user_id" = $1');
    expect(query.sql).toContain('"room_members"."removed_at" is null');
    expect(query.sql).toContain('"plans"."id" in ($2, $3)');
    expect(query.params).toEqual([user.id, ...planIds]);
  });

  it('reads name provenance for all reviewed places in one filtered batch', () => {
    const placeIds = [
      '2f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
      '5f2c7a10-4e2b-4a7c-9b1d-3e5f6a7b8c9d',
    ];
    const query = placeNameProvenanceQuery(
      drizzle.mock({ schema }) as unknown as Db,
      placeIds,
    ).toSQL();

    expect(query.sql).toContain('from "place_field_provenance"');
    expect(query.sql).toContain('"place_field_provenance"."place_id" in ($1, $2)');
    expect(query.sql).toContain('"place_field_provenance"."field" = $3');
    expect(query.params).toEqual([...placeIds, 'name']);
  });
});

describe('saved plan condition facts (#759)', () => {
  it('reports the plan and current room versions when conditions changed', () => {
    expect(
      toSavedPlanConditionFacts({ planConstraintVersion: 2, currentConstraintVersion: 4 }),
    ).toEqual({
      conditionsChanged: true,
      planConstraintVersion: 2,
      currentConstraintVersion: 4,
    });
  });

  it('keeps the signal false while the saved plan uses the current conditions', () => {
    expect(
      toSavedPlanConditionFacts({ planConstraintVersion: 4, currentConstraintVersion: 4 }),
    ).toEqual({
      conditionsChanged: false,
      planConstraintVersion: 4,
      currentConstraintVersion: 4,
    });
  });
});
