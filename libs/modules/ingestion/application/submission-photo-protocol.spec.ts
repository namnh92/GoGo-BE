import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { SubmissionPhotoService, type PreparedPhoto } from './submission-photo.service';
import { PlaceSubmissionService } from './place-submission.service';
const storedPhoto = {
  provider: 'google' as const,
  storageKey: 'places/provider/11111111-1111-4111-8111-111111111111.jpg',
  contentType: 'image/jpeg' as const,
  width: null,
  height: null,
  fetchedAt: '2026-11-09T00:00:00.000Z',
  sourceReference: 'ChIJ-822',
  attribution: 'Google Maps' as const,
  authorAttributions: [],
  googleMapsUri: null,
};

const prepared: PreparedPhoto = {
  key: storedPhoto.storageKey,
  stored: storedPhoto,
  cleanupId: 'cleanup',
  metadata: {
    provider: 'google',
    fetchedAt: storedPhoto.fetchedAt,
    sourceReference: storedPhoto.sourceReference,
    authorAttributions: storedPhoto.authorAttributions,
    googleMapsUri: null,
  },
};
function fixture() {
  const events: string[] = [];
  const current = {
    id: 'submission',
    status: 'pending',
    providerPhoto: null,
    providerPhotoClaimId: 'mine',
  };
  const execute = vi.fn(async (_query: SQL) => ({ rows: [{ claimId: 'mine' }] }));
  const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) }));
  const deleted = vi.fn(async () => undefined);
  const tx = {
    execute,
    update,
    select: () => ({
      from: () => ({ where: () => ({ for: () => ({ limit: async () => [current] }) }) }),
    }),
    delete: () => ({ where: deleted }),
  };
  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      events.push('begin');
      const answer = await fn(tx);
      events.push('commit');
      return answer;
    }),
  };
  const photos = { enabled: vi.fn(async () => true) };
  const service = new SubmissionPhotoService(db as never, photos as never, {} as never, true);
  return { service, events, current, tx, db, execute, update, deleted };
}

describe('ADR-0052 durable purchase protocol', () => {
  it('uses the shared bounded UPDATE and commits before the caller can purchase', async () => {
    const f = fixture();
    expect(await f.service.claim('submission', true)).toBe('mine');
    expect(f.events).toEqual(['begin', 'commit']);
    const query = new PgDialect().sqlToQuery(f.execute.mock.calls[1]![0]!);
    expect(query.sql).toContain("status = 'pending' and provider_photo is null");
    expect(query.sql).toContain('provider_photo_attempts < 2');
    expect(query.sql).toContain("interval '15 minutes'");
    expect(query.sql).toContain('provider_photo_attempts = provider_photo_attempts + 1');
  });
  it.each(['active', 'cap', 'decided', 'already_stored'])(
    'does not purchase when claim is refused: %s',
    async () => {
      const f = fixture();
      f.execute.mockResolvedValue({ rows: [] });
      const purchase = vi.spyOn(f.service, 'prepare');
      expect(await f.service.claimApproval('submission')).toBeUndefined();
      expect(purchase).not.toHaveBeenCalled();
    },
  );
  it.each(['mine', 'other', 'rejected'] as const)(
    'completion fences the locked row: %s',
    async (scenario) => {
      const f = fixture();
      if (scenario === 'other') f.current.providerPhotoClaimId = 'other';
      if (scenario === 'rejected') f.current.status = 'rejected';
      expect(await f.service.complete('submission', 'mine', prepared)).toBe(scenario === 'mine');
      expect(f.update).toHaveBeenCalledTimes(scenario === 'mine' ? 1 : 0);
      expect(f.deleted).toHaveBeenCalledTimes(scenario === 'mine' ? 1 : 0);
    },
  );
  it('compensation clears only its own claim and never refunds an attempt', async () => {
    const f = fixture();
    await f.service.release('submission', 'mine');
    const query = new PgDialect().sqlToQuery(f.execute.mock.calls[0]![0]!);
    expect(query.sql).toContain('provider_photo_claim_id = null');
    expect(query.sql).toContain('and provider_photo_claim_id =');
    expect(query.sql).not.toContain('provider_photo_attempts');
  });
  it.each(['provider', 'fence', 'database'] as const)(
    'submit acquisition always succeeds after %s failure and discards unused bytes',
    async (failure) => {
      const f = fixture();
      const log = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(f.service, 'acquisitionEnabled').mockResolvedValue(true);
      vi.spyOn(f.service, 'claim').mockResolvedValue('mine');
      const purchase = vi.spyOn(f.service, 'prepare').mockResolvedValue(prepared);
      if (failure === 'provider') purchase.mockRejectedValue(new Error('secret URL not logged'));
      const completion = vi.spyOn(f.service, 'complete').mockResolvedValue(false);
      if (failure === 'database') completion.mockRejectedValue(new Error('db error'));
      const discard = vi.spyOn(f.service, 'discard').mockResolvedValue();
      const release = vi.spyOn(f.service, 'release').mockResolvedValue();
      await expect(f.service.acquireSubmission('submission', 'ChIJ-822')).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledWith('submission', 'mine');
      expect(discard).toHaveBeenCalledTimes(failure === 'provider' ? 0 : 1);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret URL|ChIJ-822|Lan/);
      log.mockRestore();
    },
  );
  it.each(['purchase_failure', 'approval_rollback', 'cap'] as const)(
    'approval commits claim before prepare; compensation preserves consumed cost: %s',
    async (scenario) => {
      const f = fixture();
      if (scenario === 'cap') f.execute.mockResolvedValue({ rows: [] });
      let calls = 0;
      f.db.transaction.mockImplementation(async (fn) => {
        calls++;
        if (calls === 2) {
          f.events.push('approval rollback');
          throw new Error('approval rollback');
        }
        const result = await fn(f.tx);
        f.events.push('claim committed');
        return result;
      });
      const purchase = vi.spyOn(f.service, 'prepare').mockImplementation(async () => {
        expect(f.events).toEqual(['claim committed']);
        f.events.push('purchase');
        if (scenario === 'purchase_failure') throw new Error('purchase failure');
        return prepared;
      });
      const release = vi.spyOn(f.service, 'release').mockResolvedValue();
      const discard = vi.spyOn(f.service, 'discard').mockResolvedValue();
      const service = new PlaceSubmissionService(
        f.db as never,
        {
          resolveByProviderId: async () => ({
            status: 'RESOLVED',
            details: { providerPlaceId: 'ChIJ-822' },
          }),
          scoreFor: async () => 0,
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        f.service,
      );
      const row = {
        id: 'submission',
        googlePlaceId: 'ChIJ-822',
        providerPhoto: null,
        reviewDraft: null,
        priceMin: null,
        priceMax: null,
      };
      await expect(
        (
          service as unknown as {
            createDraftFromSubmission: (
              row: unknown,
              admin: string,
              finalize: unknown,
            ) => Promise<string>;
          }
        ).createDraftFromSubmission(row, 'admin', vi.fn()),
      ).rejects.toThrow();
      expect(purchase).toHaveBeenCalledTimes(scenario === 'cap' ? 0 : 1);
      expect(release).toHaveBeenCalledTimes(scenario === 'cap' ? 0 : 1);
      expect(discard).toHaveBeenCalledTimes(scenario === 'approval_rollback' ? 1 : 0);
    },
  );
});
