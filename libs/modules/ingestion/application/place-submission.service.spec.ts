import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@gogo/database';
import { PlaceSubmissionService } from './place-submission.service';
import type { SubmissionPhotosService } from './submission-photos.service';
import { SUBMISSION_REJECTION_REASONS } from '../domain/submission-rejection';
import type { Actor } from '../../identity/domain/actor';
import { CmsSubmissionController } from '../presentation/ingestion.controller';
import type { ZodValidationPipe } from '../../shared/zod-validation.pipe';

function fixture(over: Record<string, unknown> = {}) {
  const row = {
    id: randomUUID(),
    googlePlaceId: 'submission-key-test',
    submittedByUserId: randomUUID(),
    submittedByGuestSessionId: null,
    status: 'pending',
    submissionRevision: 1,
    submissionCount: 1,
    enrichment: null,
    resultPlaceId: null,
    rejectionReason: null,
    decisionReason: 'PRIVATE',
    createdAt: new Date(),
    decidedAt: null,
    ...over,
  };
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    for: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => [row]),
  };
  // A submission row is not evidence that an unrelated user contributed.
  query.from.mockImplementation((table: unknown) => ({
    ...query,
    limit: vi.fn(async () =>
      table === schema.placeSubmissions || table === schema.places ? [row] : [],
    ),
  }));
  const written: { table: unknown; value: Record<string, unknown> }[] = [];
  const update = vi.fn((table: unknown) => ({
    set: (value: Record<string, unknown>) => ({
      where: async () => {
        written.push({ table, value });
        Object.assign(row, value);
      },
    }),
  }));
  const tx = {
    execute: vi.fn(async () => ({
      rows: [{ id: row.submittedByUserId, mode: 'sync', epoch: 0, first_activated_at: null }],
    })),
    select: vi.fn(() => query),
    update,
    insert: (table: unknown) => ({
      values: async (value: Record<string, unknown>) => {
        written.push({ table, value });
      },
    }),
  };
  const db = {
    select: vi.fn(() => query),
    transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const photos = {
    decide: vi
      .fn<SubmissionPhotosService['decide']>()
      .mockResolvedValue({ cleanupIds: [], originalKeys: [] }),
  };
  const service = new PlaceSubmissionService(
    db as unknown as Db,
    null!,
    { emitReindex: vi.fn() } as never,
    null!,
    null!,
    photos as unknown as SubmissionPhotosService,
  );
  const owner = { id: row.submittedByUserId, type: 'user' } as Actor;
  return { row, owner, db, service, written, photos, tx };
}

/** Model separate database reads rather than sharing one mutable row object. */
function snapshotReads({ db, row }: ReturnType<typeof fixture>) {
  db.select.mockImplementation(() => {
    const snapshot = structuredClone(row);
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      for: vi.fn().mockReturnThis(),
      limit: vi.fn(async () => [snapshot]),
    };
  });
}

describe('submission erasure during decision preparation (#829)', () => {
  it.each(['rejected', 'merged'] as const)(
    '%s rediscovers an erased owner before deciding without a recipient',
    async (decision) => {
      const setup = fixture({ enrichment: { visitTips: 'Erased tip' } });
      const { row, db, service, tx, written } = setup;
      snapshotReads(setup);
      db.transaction.mockImplementationOnce(async (work) => {
        // Erasure commits after discovery and before the account/domain locks.
        Object.assign(row, {
          submittedByUserId: null,
          enrichment: null,
          submissionRevision: row.submissionRevision + 2,
        });
        return work(tx);
      });

      await expect(
        service.decide(randomUUID(), row.id, decision, 'Checked', randomUUID(), 'other'),
      ).resolves.toMatchObject({ status: decision });
      expect(db.transaction).toHaveBeenCalledTimes(2);
      expect(
        written.find((entry) => entry.table === schema.outboxEvents)?.value.payload,
      ).toMatchObject({ recipientUserId: null, approvedEvidenceCount: 0 });
      expect(written.some((entry) => entry.table === schema.assistantCreditLedger)).toBe(false);
      expect(row.enrichment).toBeNull();
    },
  );

  it('revalidates an enrichment selection against the erased row before any writes', async () => {
    const setup = fixture({ enrichment: { visitTips: 'Erased tip' } });
    const { row, db, service, tx, written, photos } = setup;
    snapshotReads(setup);
    Object.assign(photos, { list: vi.fn(async () => []) });
    db.transaction.mockImplementationOnce(async (work) => {
      Object.assign(row, {
        submittedByUserId: null,
        enrichment: null,
        submissionRevision: row.submissionRevision + 2,
      });
      return work(tx);
    });

    await expect(
      service.decide(
        randomUUID(),
        row.id,
        'merged',
        'Checked',
        randomUUID(),
        undefined,
        undefined,
        { keptFactKeys: ['visitTips'], keptPhotoMediaIds: [] },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ENRICHMENT_SELECTION' });
    expect(row.status).toBe('pending');
    expect(written).toEqual([]);
    expect(photos.decide).not.toHaveBeenCalled();
  });

  it('still rejects a contributor/moderator revision change without retrying', async () => {
    const setup = fixture();
    const { row, db, service, tx, written } = setup;
    snapshotReads(setup);
    db.transaction.mockImplementationOnce(async (work) => {
      row.submissionRevision++;
      return work(tx);
    });
    await expect(
      service.decide(randomUUID(), row.id, 'rejected', 'Checked', undefined, 'other'),
    ).rejects.toMatchObject({ code: 'SUBMISSION_CHANGED' });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(written).toEqual([]);
  });
});

// Exercise the actual HTTP body pipe; do not copy its Zod rules into the test.
const routeArgs = Reflect.getMetadata(
  '__routeArguments__',
  CmsSubmissionController,
  'decide',
) as Record<string, { pipes: ZodValidationPipe<unknown>[] }>;
const decisionPipe = Object.values(routeArgs)
  .flatMap((arg) => arg.pipes)
  .find((pipe) => typeof pipe === 'object' && 'transform' in pipe)!;

describe('submission rejection validation (#787)', () => {
  it.each([undefined, null, '', 'duplicate', 'PRIVATE', 'DUPLICATE_PLACE', 42])(
    'HTTP rejects missing/invalid key %s',
    (rejectionReason) => {
      expect(() =>
        decisionPipe.transform({ decision: 'rejected', reason: 'PRIVATE', rejectionReason }),
      ).toThrow(
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          options: {
            fieldErrors: [expect.objectContaining({ field: 'rejectionReason' })],
          },
        }),
      );
    },
  );

  it.each([undefined, '', 'unknown', 'PRIVATE'])(
    'service rejects %s before DB access',
    async (key) => {
      const { service, db } = fixture();
      await expect(
        service.decide(randomUUID(), randomUUID(), 'rejected', 'PRIVATE', undefined, key),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        options: {
          fieldErrors: [expect.objectContaining({ field: 'rejectionReason' })],
        },
      });
      expect(db.select).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    },
  );

  it.each(SUBMISSION_REJECTION_REASONS)('HTTP accepts key %s without an internal note', (key) => {
    expect(decisionPipe.transform({ decision: 'rejected', rejectionReason: key })).toEqual({
      decision: 'rejected',
      rejectionReason: key,
    });
  });

  it.each(['approved', 'merged'])('%s still requires an internal reason', (decision) => {
    expect(() => decisionPipe.transform({ decision })).toThrow();
    expect(decisionPipe.transform({ decision, reason: 'Checked' })).toMatchObject({
      decision,
      reason: 'Checked',
    });
  });
});

describe('submission public response (#787)', () => {
  it.each(SUBMISSION_REJECTION_REASONS)(
    'stores %s with the decision/audit and polls it',
    async (key) => {
      const { row, service, owner, db, written, photos, tx } = fixture();
      const adminId = randomUUID();
      await service.decide(adminId, row.id, 'rejected', 'PRIVATE', undefined, key);
      expect(db.transaction).toHaveBeenCalledOnce();
      expect(photos.decide).toHaveBeenCalledExactlyOnceWith(
        tx,
        row.id,
        null,
        adminId,
        'PRIVATE',
        undefined,
      );
      expect(written.find((entry) => entry.table === schema.placeSubmissions)?.value).toMatchObject(
        { status: 'rejected', rejectionReason: key, decisionReason: 'PRIVATE' },
      );
      expect(written.find((entry) => entry.table === schema.auditLogs)?.value.diff).toMatchObject({
        decision: 'rejected',
        rejectionReason: key,
      });
      expect(
        written.find((entry) => entry.table === schema.outboxEvents)?.value.payload,
      ).toMatchObject({
        submissionId: row.id,
        googlePlaceId: row.googlePlaceId,
        venueIdentity: `google:${row.googlePlaceId}`,
        variant: 'rejected',
        recipientUserId: row.submittedByUserId,
        grantOwner: 'sync',
        approvedEvidenceCount: 0,
        rejectionReason: key,
        decision: 'rejected',
        resultPlaceId: null,
      });
      // Model the timestamp returned by Postgres rather than the SQL expression.
      row.decidedAt = null;
      const result = await service.getSubmission(owner, row.id);
      expect(result.rejectionReason).toBe(key);
      expect(result).not.toHaveProperty('decisionReason');
      expect(result).not.toHaveProperty('reason');
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    },
  );

  it.each(['pending', 'approved', 'merged'])('omits rejectionReason for %s', async (status) => {
    const { service, owner, row } = fixture({ status, rejectionReason: 'other' });
    expect(JSON.stringify(await service.getSubmission(owner, row.id))).not.toContain(
      'rejectionReason',
    );
  });

  it('keeps legacy private notes private and leaves their public key absent', async () => {
    const { service, owner, row } = fixture({ status: 'rejected' });
    const result = await service.getSubmission(owner, row.id);
    expect(result.rejectionReason).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each(['user', 'guest'])(
    'denies a different %s actor with no recorded contribution',
    async (type) => {
      const { service, row } = fixture({ status: 'rejected', rejectionReason: 'other' });
      await expect(
        service.getSubmission({ id: randomUUID(), type } as Actor, row.id),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    },
  );

  it('allows the owning guest to read the public key', async () => {
    const guestId = randomUUID();
    const { service, row } = fixture({
      status: 'rejected',
      rejectionReason: 'other',
      submittedByUserId: null,
      submittedByGuestSessionId: guestId,
    });
    expect(
      (await service.getSubmission({ id: guestId, type: 'guest' } as Actor, row.id))
        .rejectionReason,
    ).toBe('other');
  });
});

describe('CMS credit preview (#806)', () => {
  it.each([0, 1, 3])('returns the actual award formula with %s kept photos', async (count) => {
    const mediaIds = Array.from({ length: count }, () => randomUUID());
    const { service, row, db, photos } = fixture({
      enrichment: {
        visitTips: 'Tip',
        photos: mediaIds.map((mediaId) => ({ mediaId, kind: 'menu' })),
      },
    });
    Object.assign(db, { execute: vi.fn(async () => ({ rows: [{ id: row.submittedByUserId }] })) });
    Object.assign(photos, {
      list: vi.fn(async () => mediaIds.map((mediaId) => ({ mediaId, status: 'pending' }))),
    });
    expect(
      await service.previewEnrichmentCredit(row.id, {
        keptFactKeys: [],
        keptPhotoMediaIds: mediaIds,
      }),
    ).toEqual({ expectedCredit: { base: 50, photoBonus: count ? 20 : 0, total: count ? 70 : 50 } });
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('returns zero when the venue was already credited or the contributor is ineligible', async () => {
    const { service, row, db, photos } = fixture({ enrichment: null });
    Object.assign(db, { execute: vi.fn(async () => ({ rows: [] })) });
    Object.assign(photos, { list: vi.fn(async () => []) });
    expect(
      await service.previewEnrichmentCredit(row.id, { keptFactKeys: [], keptPhotoMediaIds: [] }),
    ).toEqual({ expectedCredit: { base: 0, photoBonus: 0, total: 0 } });
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('refuses a removed photo rather than advertising its bonus', async () => {
    const mediaId = randomUUID();
    const { service, row, photos } = fixture({
      enrichment: { photos: [{ mediaId, kind: 'bill' }] },
    });
    Object.assign(photos, { list: vi.fn(async () => [{ mediaId, status: 'rejected' }]) });
    await expect(
      service.previewEnrichmentCredit(row.id, { keptFactKeys: [], keptPhotoMediaIds: [mediaId] }),
    ).rejects.toMatchObject({ code: 'INVALID_ENRICHMENT_SELECTION' });
  });
  it('refuses preview after decision and rejects keep selection on rejection', async () => {
    const { service, row, db } = fixture({ status: 'approved' });
    await expect(
      service.previewEnrichmentCredit(row.id, { keptFactKeys: [], keptPhotoMediaIds: [] }),
    ).rejects.toMatchObject({ code: 'ALREADY_DECIDED' });
    expect(db.transaction).not.toHaveBeenCalled();
    const pending = fixture();
    await expect(
      pending.service.decide(
        randomUUID(),
        pending.row.id,
        'rejected',
        'Checked',
        undefined,
        'inappropriate_content',
        undefined,
        { keptFactKeys: [], keptPhotoMediaIds: [] },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ENRICHMENT_SELECTION' });
    expect(pending.db.transaction).not.toHaveBeenCalled();
  });
});
