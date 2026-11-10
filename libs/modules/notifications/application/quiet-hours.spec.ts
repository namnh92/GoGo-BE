import type { Db } from '@gogo/database';
import { describe, expect, it, vi } from 'vitest';
import { deferPushDuringQuiet } from './quiet-hours';

describe('quiet decision erasure fence', () => {
  it('does not stage deferred work for an account erased while waiting for its lock', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const defer = vi.fn();
    const db = {
      transaction: async (run: (tx: { execute: typeof execute }) => Promise<unknown>) =>
        run({ execute }),
    } as unknown as Db;
    await expect(
      deferPushDuringQuiet(db, '00000000-0000-4000-8000-000000000001', defer),
    ).rejects.toThrow('NOTIFICATION_ACCOUNT_UNAVAILABLE');
    expect(defer).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });
});
