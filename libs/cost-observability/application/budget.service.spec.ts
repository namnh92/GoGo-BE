import { describe, expect, it } from 'vitest';
import { COST_REGISTRY } from '../domain/registry';
import { scopeExpectsUsage } from './budget.service';

describe('scopeExpectsUsage — which budget scopes can see a USAGE row', () => {
  const service = (id: string) => scopeExpectsUsage(COST_REGISTRY, { kind: 'SERVICE', id });

  it('expects usage from a collected or estimated service', () => {
    expect(service('google.places')).toBe(true);
    expect(service('github.actions')).toBe(true);
    expect(service('sentry.errors')).toBe(true);
  });

  it('a manual-only service under an AUTO provider is a known zero, not a missing feed (#695 F-01)', () => {
    // The plan fee is typed in; nothing ever meters it, so its absent usage
    // half must read NOT_APPLICABLE, not NO_USAGE_ROWS.
    expect(service('sentry.subscription')).toBe(false);
    expect(service('github.subscription')).toBe(false);
    expect(service('google.play_console')).toBe(false);
  });

  it('a manual-only provider expects nothing; an AUTO provider or the total still does', () => {
    expect(scopeExpectsUsage(COST_REGISTRY, { kind: 'PROVIDER', id: 'hosting' })).toBe(false);
    expect(scopeExpectsUsage(COST_REGISTRY, { kind: 'PROVIDER', id: 'sentry' })).toBe(true);
    expect(scopeExpectsUsage(COST_REGISTRY, { kind: 'TOTAL', id: null })).toBe(true);
    expect(service('nope.nothing')).toBe(false);
  });
});
