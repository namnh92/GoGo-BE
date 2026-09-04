import { describe, expect, it } from 'vitest';
import { refuseAudit } from './audit.port';

/**
 * #388 — the read-only writer refuses rather than swallows.
 *
 * `CostCenterService` constructs a `BudgetService` it only ever reads from. A
 * no-op writer there would mean the day someone calls a writing method from
 * the read path, the mutation lands and the audit row does not — a silent gap
 * in an append-only log, discovered later or never.
 */
describe('refuseAudit', () => {
  it('throws, naming what the composer forgot', async () => {
    await expect(
      refuseAudit({} as never, {
        actorType: 'system',
        action: 'cost.budget.set',
        resourceType: 'cost_budget',
        resourceId: 'x',
      }),
    ).rejects.toThrow(/constructed read-only and has no audit writer/);
  });
});
