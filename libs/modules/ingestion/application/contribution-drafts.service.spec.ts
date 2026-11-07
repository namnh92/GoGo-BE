import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { schema } from '@gogo/database';
import { ContributionDraftsService } from './contribution-drafts.service';
import type { Actor } from '../../identity/domain/actor';

it.each(['menu', 'bill'] as const)(
  'F-07 persists canonical %s references and retains photos to draft expiry',
  async (kind) => {
    const actor: Actor = { type: 'user', id: randomUUID(), sessionId: randomUUID() };
    const id = randomUUID(),
      mediaId = randomUUID();
    const prepared = { photos: [{ key: 'submission-photos/retained.webp' }] };
    const photos = { prepare: vi.fn().mockResolvedValue(prepared), retainDraft: vi.fn() };
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            table === schema.taxonomies ? Promise.resolve([]) : { for: async () => [] },
        }),
      }),
      execute: vi.fn().mockResolvedValue({ rows: [{ id: actor.id, n: 0 }] }),
      insert: () => ({
        values: (values: object) => ({
          onConflictDoNothing: () => ({
            returning: async () => [{ ...values, version: 1, updatedAt: new Date() }],
          }),
        }),
      }),
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
    };
    const service = new ContributionDraftsService(db as never, photos as never);
    const saved = await service.save(actor, id, {
      googlePlaceId: 'draft-place',
      expectedVersion: 0,
      enrichment: {
        billPhotoPublicConsent: true,
        photos: [{ mediaId: mediaId.toUpperCase(), kind }],
      },
    });
    expect(saved.enrichment.photos).toEqual([{ mediaId, kind }]);
    expect(photos.prepare).toHaveBeenCalledWith(actor, [mediaId], null, {
      draftId: id,
      evidence: [{ mediaId, kind }],
      billPhotoPublicConsent: true,
    });
    expect(photos.retainDraft).toHaveBeenCalledWith(
      db,
      actor,
      id,
      prepared,
      new Date(saved.expiresAt),
    );
    expect(new Date(saved.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * 86400000);
  },
);

describe('draft deletion cleanup', () => {
  it('releases claims only after successful versioned deletion in the same transaction', async () => {
    const photos = { releaseDraft: vi.fn() };
    let rows: object[] = [{ id: 'draft' }];
    const db = {
      execute: vi.fn(),
      delete: () => ({ where: () => ({ returning: async () => rows }) }),
      transaction: async (work: (tx: unknown) => unknown) => work(db),
    };
    const service = new ContributionDraftsService(db as never, photos as never);
    const actor = { type: 'user', id: randomUUID() } as Actor;
    await expect(service.delete(actor, 'draft', 1)).resolves.toEqual({ deleted: true });
    expect(photos.releaseDraft).toHaveBeenCalledWith(db, 'draft');
    rows = [];
    photos.releaseDraft.mockClear();
    await expect(service.delete(actor, 'draft', 1)).rejects.toMatchObject({ httpStatus: 404 });
    expect(photos.releaseDraft).not.toHaveBeenCalled();
  });
});
