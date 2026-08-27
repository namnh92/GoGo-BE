import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * BE-IMP-007 — request identity available to code that never sees the request.
 *
 * Audit rows are written deep in services that take no HTTP argument, so until
 * now `request_id` was declared on `audit_logs` and never populated, and there
 * was no way to record the actor's IP at all. Threading a context object
 * through every service signature to fix that would touch every call site and
 * still be forgotten on the next one.
 *
 * AsyncLocalStorage keeps it out of the signatures: one hook fills it per
 * request, audit writers read it. Outside a request — worker jobs, tests — the
 * store is simply empty, which is the correct answer there.
 */
export type RequestContext = {
  requestId?: string | undefined;
  /** Client IP as resolved by Fastify, i.e. already honouring TRUST_PROXY. */
  ip?: string | undefined;
  /**
   * SEC-002 — which rule let this request through the CMS role gate.
   *
   * `exact_role` and `rank_read` are the model working as designed.
   * `super_admin_bypass` means the request would have been refused for any
   * other role: it is the escape hatch, and how often it is used is the signal
   * for whether the role model fits the work. Set by AdminGuard, which is the
   * only place that knows.
   */
  authorizationPath?: 'exact_role' | 'rank_read' | 'super_admin_bypass' | undefined;
};

/** Mutable within the request: AdminGuard fills this after the store exists. */
export function setAuthorizationPath(path: NonNullable<RequestContext['authorizationPath']>): void {
  const store = storage.getStore();
  if (store) store.authorizationPath = path;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext {
  return storage.getStore() ?? {};
}
