import { describe, expect, it } from 'vitest';
import {
  PER_COLLECTOR_APPROVAL_LINE_MICROS,
  defaultMonitoringBudgetMicros,
  isEnabledIn,
  monitoringCostSummary,
  type MonitoringCost,
} from './collector';
import { freshnessStatus, nextAttemptDelayMs } from './freshness';

const NOW = new Date('2026-09-02T12:00:00Z');
const H = 60 * 60 * 1000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * H);

describe('freshnessStatus (epic §23)', () => {
  it('is UNKNOWN when never attempted — no numbers exist, a report shows "—"', () => {
    expect(
      freshnessStatus(
        { lastSuccessfulAt: null, lastAttemptAt: null, staleAfterMs: H, consecutiveFailures: 0 },
        NOW,
      ),
    ).toBe('UNKNOWN');
  });

  it('is UNAVAILABLE when attempted but never succeeded', () => {
    expect(
      freshnessStatus(
        { lastSuccessfulAt: null, lastAttemptAt: at(0), staleAfterMs: H, consecutiveFailures: 1 },
        NOW,
      ),
    ).toBe('UNAVAILABLE');
  });

  it('is FRESH inside the trust window, even if the latest attempt failed', () => {
    expect(
      freshnessStatus(
        {
          lastSuccessfulAt: at(0.5),
          lastAttemptAt: at(0),
          staleAfterMs: H,
          consecutiveFailures: 2,
        },
        NOW,
      ),
    ).toBe('FRESH');
  });

  it('is STALE past the window with no failure on record, UNAVAILABLE past it with one', () => {
    expect(
      freshnessStatus(
        { lastSuccessfulAt: at(3), lastAttemptAt: at(3), staleAfterMs: H, consecutiveFailures: 0 },
        NOW,
      ),
    ).toBe('STALE');
    expect(
      freshnessStatus(
        { lastSuccessfulAt: at(3), lastAttemptAt: at(0), staleAfterMs: H, consecutiveFailures: 1 },
        NOW,
      ),
    ).toBe('UNAVAILABLE');
  });

  it('is derived, not stored: the same facts read FRESH now and STALE later', () => {
    const facts = {
      lastSuccessfulAt: at(0),
      lastAttemptAt: at(0),
      staleAfterMs: H,
      consecutiveFailures: 0,
    };
    expect(freshnessStatus(facts, NOW)).toBe('FRESH');
    expect(freshnessStatus(facts, new Date(NOW.getTime() + 2 * H))).toBe('STALE');
  });
});

describe('nextAttemptDelayMs (epic §22 — no hot retry loop)', () => {
  it('doubles per consecutive failure and caps at eight times the frequency', () => {
    expect(nextAttemptDelayMs(1_000, 0)).toBe(1_000);
    expect(nextAttemptDelayMs(1_000, 1)).toBe(2_000);
    expect(nextAttemptDelayMs(1_000, 3)).toBe(8_000);
    expect(nextAttemptDelayMs(1_000, 10)).toBe(8_000);
  });
});

const cost = (over: Partial<MonitoringCost>): MonitoringCost => ({
  model: 'FIXED',
  estimatedMonthlyMicros: 100_000,
  currency: 'USD',
  expectedRequestsPerMonth: null,
  pricingSource: 'test',
  lastPricingReview: '2026-09-02',
  ...over,
});

describe('monitoringCostSummary (epic §20–§21)', () => {
  it('sums known estimates, treats FREE as zero, and names unknowns instead of zeroing them', () => {
    const s = monitoringCostSummary([
      { id: 'a', monitoringCost: cost({ model: 'FREE', estimatedMonthlyMicros: null }) },
      { id: 'b', monitoringCost: cost({ estimatedMonthlyMicros: 300_000 }) },
      { id: 'c', monitoringCost: cost({ model: 'UNKNOWN', estimatedMonthlyMicros: null }) },
      { id: 'd', monitoringCost: cost({ model: 'PER_REQUEST', estimatedMonthlyMicros: null }) },
    ]);
    expect(s.knownMonthlyMicros).toBe(300_000);
    expect(s.unknown).toEqual(['c', 'd']);
    expect(s.needsApproval).toEqual([]);
  });

  it('flags any single collector above the $1/month approval line', () => {
    const s = monitoringCostSummary([
      {
        id: 'aws_ce',
        monitoringCost: cost({
          model: 'PER_REQUEST',
          estimatedMonthlyMicros: PER_COLLECTOR_APPROVAL_LINE_MICROS + 1,
        }),
      },
    ]);
    expect(s.needsApproval).toEqual(['aws_ce']);
  });

  it('defaults the budget per environment as the epic says', () => {
    expect(defaultMonitoringBudgetMicros('dev')).toBe(1_000_000);
    expect(defaultMonitoringBudgetMicros('staging')).toBe(1_000_000);
    expect(defaultMonitoringBudgetMicros('prod')).toBe(5_000_000);
  });

  it('honours enabledEnvironments', () => {
    expect(isEnabledIn({ enabledEnvironments: 'all' }, 'prod')).toBe(true);
    expect(isEnabledIn({ enabledEnvironments: ['dev'] }, 'prod')).toBe(false);
  });
});
