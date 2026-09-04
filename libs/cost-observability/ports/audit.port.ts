import type { Db } from '@gogo/database';

/**
 * COST-BE-029 (#388) — epic §39, the one dependency that could not come with
 * the package.
 *
 * Everything else under `libs/modules/cost` reached only for `@gogo/database`,
 * `@gogo/observability` and `@gogo/providers`, all of which sit below this
 * package. `writeAudit` did not: it lives in `libs/modules/shared/audit.ts`
 * because it fills `request_id` and the admin IP from the AsyncLocalStorage
 * request context, which is a Nest/Fastify concern and belongs with the
 * modules that have a request.
 *
 * Importing it from here would have made `@gogo/cost-observability` depend on
 * `@gogo/modules`, which re-exports this package — a cycle, and the exact
 * thing `check:boundaries` exists to prevent. So the direction is inverted:
 * the package declares *what it needs written*, and whoever composes it
 * supplies the writer. `@gogo/modules` passes its real `writeAudit`; nothing
 * about the audit row's shape or its request-context enrichment changes.
 */

/** The audit row a cost service asks for. Mirrors `AuditInput` in `@gogo/modules`. */
export type CostAuditEntry = {
  actorType: 'admin' | 'user' | 'system';
  actorId?: string | null | undefined;
  action: string;
  resourceType: string;
  resourceId: string;
  diff?: unknown;
};

/**
 * Writes one audit row.
 *
 * Takes the `db` at the call site rather than closing over one, so an audit
 * stays inside the transaction that produced it — the reason
 * `@gogo/modules`' writer accepts `Pick<Db, 'insert'>` and not just a pool.
 */
export type CostAuditWriter = (db: Pick<Db, 'insert'>, entry: CostAuditEntry) => Promise<void>;

/**
 * For a service instance that exists only to read.
 *
 * `CostCenterService` builds a `BudgetService` to ask it for the month's
 * budgets and never calls a method that writes. Handing it a no-op writer
 * would mean a future call to `upsert()` from the read path silently loses an
 * audit row; this throws instead, on the first such call, naming what is
 * wrong. A loud failure in a code path nobody should reach is cheaper than a
 * quiet gap in the audit log.
 */
export const refuseAudit: CostAuditWriter = async () => {
  // `async`, not a bare `throw`: the type says it returns a promise, and a
  // caller that does `.catch()` instead of `await` must see a rejection rather
  // than a synchronous throw past its handler.
  throw new Error(
    'cost-observability: this service was constructed read-only and has no audit writer; ' +
      'pass one (@gogo/modules `writeAudit`) to use a method that writes.',
  );
};
