import { describe, expect, it } from 'vitest';
import { meterRowsFor } from './usage-ledger';
import { listCostMicros, operationForSku } from '../pricing/provider-pricing';

describe('#776 address backfill accounting', () => {
  it('records attempts and billed units against the Essentials SKU', () => {
    expect(
      meterRowsFor('2026-11-06', 'dev', 'google.details.address', {
        attempted: 3,
        succeeded: 2,
        units: 2,
      }),
    ).toMatchObject([
      { operationId: 'google.details.address', metric: 'calls', quantity: 3, billingSkuId: null },
      {
        operationId: 'google.details.address',
        metric: 'requests',
        quantity: 2,
        billingSkuId: 'places.details.essentials',
      },
    ]);
    expect(operationForSku('places.details.essentials')).toBe('google.details.address');
    expect(listCostMicros('google.details.address', '2026-11-06', 2)).toBeNull();
  });
});
