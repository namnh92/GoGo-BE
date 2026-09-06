import type { RuntimeCallStatus, RuntimeOperation } from './runtime-telemetry';

/**
 * #427 — the last outcome of the operations a process runs *once*, at boot,
 * rather than per request: the rate-limit Redis warm-up today. A counter
 * says how many boots ended each way across the fleet; this says how *this*
 * process's attempt ended and when, which is what a console row needs.
 *
 * In memory, per process, no history: one entry per operation, overwritten
 * on the next attempt. Read by the Cost Center to put `runtime.connection`
 * on the service row. A process with nothing to warm (the worker, a test
 * module) simply has nothing recorded.
 */
export const RUNTIME_STATE = Symbol('RUNTIME_STATE');

export type RuntimeState = {
  operation: string;
  status: RuntimeCallStatus;
  observedAt: string;
};

/** The read side, structural so a leaf package can take it without importing this one. */
export type RuntimeStateReader = {
  get(operation: string): RuntimeState | null;
};

export class RuntimeStateStore implements RuntimeStateReader {
  private readonly states = new Map<string, RuntimeState>();

  record(op: RuntimeOperation, status: RuntimeCallStatus, at: Date = new Date()): RuntimeState {
    const state = { operation: op.operation, status, observedAt: at.toISOString() };
    this.states.set(op.operation, state);
    return state;
  }

  get(operation: string): RuntimeState | null {
    return this.states.get(operation) ?? null;
  }

  snapshot(): RuntimeState[] {
    return [...this.states.values()];
  }
}
