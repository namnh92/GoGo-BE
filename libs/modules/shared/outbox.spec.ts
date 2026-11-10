import { describe, expect, it } from 'vitest';
import { writeOutbox } from './outbox';

describe('outbox payload versions (#829 CE-F-04)', () => {
  it.each([undefined, 2])(
    'stores explicit version %s, defaulting only omitted versions to 1',
    async (version) => {
      let stored: Record<string, unknown> = {};
      const db = {
        insert: () => ({
          values: async (row: Record<string, unknown>) => {
            stored = row;
          },
        }),
      };
      await writeOutbox(db as never, {
        eventType: 'place.submission_decided',
        resourceType: 'place_submission',
        resourceId: 's',
        payload: { grantOwner: 'sync' },
        payloadSchemaVersion: version,
      });
      expect(stored.payloadSchemaVersion).toBe(version ?? 1);
      expect(stored.eventVersion).toBe(1);
    },
  );
});
