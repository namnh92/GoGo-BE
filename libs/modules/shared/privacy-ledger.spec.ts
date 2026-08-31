import { describe, expect, it } from 'vitest';
import { SLA_DEFAULTS, dueDates, monthKey, retentionDate, slaConfigFrom } from './privacy-ledger';

describe('privacy ledger arithmetic (#255)', () => {
  it('falls back to the provisional defaults when nothing is configured', () => {
    expect(slaConfigFrom('')).toEqual(SLA_DEFAULTS);
  });

  /*
   * Per-type overrides merge over the defaults rather than replacing the
   * table: Legal confirming the delete window must not silently erase the
   * export window.
   */
  it('merges a partial override per type', () => {
    const config = slaConfigFrom(JSON.stringify({ delete: { ackHours: 24, fulfillHours: 240 } }));
    expect(config.delete).toEqual({ ackHours: 24, fulfillHours: 240 });
    expect(config.export).toEqual(SLA_DEFAULTS.export);
  });

  it('computes due dates from the window of the request type', () => {
    const received = new Date('2026-08-31T00:00:00Z');
    const due = dueDates(
      { ...SLA_DEFAULTS, export: { ackHours: 10, fulfillHours: 100 } },
      'export',
      received,
    );
    expect(due.ackDueAt.toISOString()).toBe('2026-08-31T10:00:00.000Z');
    expect(due.fulfillmentDueAt.toISOString()).toBe('2026-09-04T04:00:00.000Z');
  });

  it('stamps retention as closure plus the policy, in calendar months', () => {
    expect(retentionDate(new Date('2026-08-31T12:00:00Z'), 12).toISOString()).toBe(
      '2027-08-31T12:00:00.000Z',
    );
  });

  it('keys metrics by calendar month', () => {
    expect(monthKey(new Date('2026-08-31T23:59:59Z'))).toBe('2026-08');
  });
});
