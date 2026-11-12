import type { Db } from '@gogo/database';
import { NoopMetrics } from '@gogo/observability';
import { expect, it, vi } from 'vitest';
import { assertInviteFoundationReady } from './invite-foundation-readiness';
function fixture() {
  const execute = vi.fn().mockResolvedValueOnce({ rows: [] });
  for (let i = 0; i < 4; i += 1) execute.mockResolvedValueOnce({ rows: [{}] });
  execute
    .mockResolvedValueOnce({ rows: Array(11).fill({}) })
    .mockResolvedValueOnce({ rows: [{}, {}] });
  const metrics = new NoopMetrics();
  const emit = vi.spyOn(metrics, 'increment');
  return { execute, metrics, emit, db: { execute } as unknown as Pick<Db, 'execute'> };
}
it('re-probes after success and fails closed on missing schema/indexes or a catalog outage', async () => {
  const f = fixture();
  await assertInviteFoundationReady(f.db, f.metrics);
  f.execute.mockRejectedValueOnce(new Error('driver error with secret marker'));
  await expect(assertInviteFoundationReady(f.db, f.metrics)).rejects.toThrow('SCHEMA_NOT_READY');
  expect(f.emit).toHaveBeenCalledWith('room_invite_foundation_readiness_total', {
    operation: 'schema',
    result: 'unavailable',
  });
  expect(JSON.stringify(f.emit.mock.calls)).not.toContain('secret marker');
});
it('rejects a missing or incompatible index, unvalidated constraints and disabled triggers', async () => {
  for (const step of [1, 2, 3, 4, 5, 6]) {
    const f = fixture();
    f.execute.mockReset();
    const rows = [[], [{}], [{}], [{}], [{}], Array(11).fill({}), [{}, {}]];
    rows[step] = [];
    for (const value of rows) f.execute.mockResolvedValueOnce({ rows: value });
    await expect(assertInviteFoundationReady(f.db, f.metrics)).rejects.toThrow('SCHEMA_NOT_READY');
  }
});
