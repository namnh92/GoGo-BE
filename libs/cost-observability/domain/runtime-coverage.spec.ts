import { describe, expect, it } from 'vitest';
import { COST_REGISTRY } from './registry';
import { providerRuntime, serviceRuntime } from './runtime-coverage';

/**
 * ADR-0014 — coverage is a function of the registry and nothing else, so
 * every expectation here is about registry data, and none needs a database,
 * a collector or a clock.
 */
describe('serviceRuntime', () => {
  it('is N/A without a surface, whatever the operations say', () => {
    expect(serviceRuntime({ runtime: 'none', operations: [] })).toEqual({
      surface: 'none',
      coverage: 'N/A',
      operations: { instrumented: 0, total: 0 },
    });
  });

  it('is NOT_INSTRUMENTED with a surface and nothing measured — including nothing registered', () => {
    expect(serviceRuntime({ runtime: 'in_process', operations: [] }).coverage).toBe(
      'NOT_INSTRUMENTED',
    );
    expect(serviceRuntime({ runtime: 'client_sdk', operations: [op(false)] })).toEqual({
      surface: 'client_sdk',
      coverage: 'NOT_INSTRUMENTED',
      operations: { instrumented: 0, total: 1 },
    });
  });

  it('is FULL only when every operation emits, PARTIAL when some do', () => {
    expect(serviceRuntime({ runtime: 'in_process', operations: [op(true), op(true)] })).toEqual({
      surface: 'in_process',
      coverage: 'FULL',
      operations: { instrumented: 2, total: 2 },
    });
    expect(serviceRuntime({ runtime: 'in_process', operations: [op(true), op(false)] })).toEqual({
      surface: 'in_process',
      coverage: 'PARTIAL',
      operations: { instrumented: 1, total: 2 },
    });
  });
});

describe('providerRuntime', () => {
  it('Google today is PARTIAL: Places, Routes and Sheets measured, both Maps SDKs not', () => {
    expect(providerRuntime(COST_REGISTRY.provider('google')!)).toEqual({
      coverage: 'PARTIAL',
      services: { full: 3, partial: 0, notInstrumented: 2 },
      operations: { instrumented: 10, total: 12 },
    });
  });

  it('a provider this process calls and never measures is NOT_INSTRUMENTED, not N/A', () => {
    // The shape Upstash and Neon had before #414: a surface, nothing registered on it.
    const unmeasured = {
      services: [
        { id: 'x.cache', runtime: 'in_process' as const, operations: [] },
        { id: 'x.edge', runtime: 'none' as const, operations: [] },
      ],
    };
    expect(providerRuntime(unmeasured)).toEqual({
      coverage: 'NOT_INSTRUMENTED',
      services: { full: 0, partial: 0, notInstrumented: 1 },
      operations: { instrumented: 0, total: 0 },
    });
  });

  it('an infrastructure provider measured on every declared operation is FULL (#414)', () => {
    for (const id of ['upstash', 'neon']) {
      expect(providerRuntime(COST_REGISTRY.provider(id)!), id).toMatchObject({
        coverage: 'FULL',
        services: { full: 1, partial: 0, notInstrumented: 0 },
      });
    }
    // Cloudflare: R2 is only signed for here, Workers run at the edge — no surface.
    expect(providerRuntime(COST_REGISTRY.provider('cloudflare')!).coverage).toBe('N/A');
  });

  it('a provider with no runtime surface anywhere is N/A: bills, CI, fees, planned', () => {
    for (const id of ['aws', 'github', 'gogo', 'apple', 'hosting', 'registrar', 'onesignal']) {
      expect(providerRuntime(COST_REGISTRY.provider(id)!), id).toEqual({
        coverage: 'N/A',
        services: { full: 0, partial: 0, notInstrumented: 0 },
        operations: { instrumented: 0, total: 0 },
      });
    }
  });

  it('is FULL only when every surfaced service is FULL; N/A services never count against it', () => {
    expect(
      providerRuntime({
        services: [
          { runtime: 'in_process', operations: [op(true)] },
          { runtime: 'none', operations: [] },
        ],
      }),
    ).toEqual({
      coverage: 'FULL',
      services: { full: 1, partial: 0, notInstrumented: 0 },
      operations: { instrumented: 1, total: 1 },
    });
    expect(
      providerRuntime({
        services: [
          { runtime: 'in_process', operations: [op(true)] },
          { runtime: 'in_process', operations: [] },
        ],
      }).coverage,
    ).toBe('PARTIAL');
  });
});

function op(instrumented: boolean) {
  return { id: 'x.op', serviceId: 'x', displayName: 'op', instrumented, usageMeters: [] };
}
