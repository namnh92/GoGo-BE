import { describe, expect, it, vi } from 'vitest';
import { CmsAssistantCreditsService } from './cms-assistant-credits.service';

describe('#851 MAJOR tolerant CMS credit history', () => {
  it('preserves open evidence reasons without exposing entitlement keys', async () => {
    const db = {
      execute: vi.fn(async () => ({
        rows: [
          {
            user_id: 'user',
            display_name: 'Contributor',
            balance: 60,
            id: 'ledger',
            created_at: '2026-11-10T00:00:00.000000Z',
            delta: 10,
            reason: 'submission_evidence',
            submission_id: 'submission',
            venue_identity: 'google:ABC',
            place_id: 'place',
          },
        ],
      })),
      insert: () => ({ values: async () => undefined }),
    };
    const result = await new CmsAssistantCreditsService(db as never).read(
      'user',
      { limit: 10 },
      'admin',
    );
    expect(result.balance).toBe(60);
    expect(result.items).toEqual([
      {
        id: 'ledger',
        createdAt: '2026-11-10T00:00:00.000000Z',
        delta: 10,
        reason: 'submission_evidence',
        submissionId: 'submission',
        venueIdentity: 'google:ABC',
        placeId: 'place',
      },
    ]);
  });
});
