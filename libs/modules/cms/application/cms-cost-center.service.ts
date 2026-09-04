import { Inject, Injectable } from '@nestjs/common';
import {
  COST_REGISTRY,
  CostCenterService,
  ManualCostError,
  ManualCostService,
  TestCostService,
  type CostOverview,
  type CostWindow,
  type EligibleManualService,
  type ManualCostActor,
  type ManualCostItem,
  type ManualCostItemInput,
  type ManualCostItemPatch,
  type ProviderCostRow,
  type ServiceCostDetail,
  type TestRunDetail,
  type TestRunRecord,
} from '@gogo/cost-observability';
import { type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG } from '../../shared/config';
import { DB } from '../../shared/tokens';
import { writeAudit } from '../../shared/audit';

type CostCenterConfig = {
  /** #335 — which deployment's rows are ours. */
  APP_ENV?: string;
  /** #335 — off means the in-process ledger writes nothing; the payload says so. */
  COST_LEDGER_ENABLED?: boolean;
};

/**
 * COST-BE-022 (#381) — the Cost Center behind `/cms/ops/costs*`.
 *
 * Thin on purpose: it turns Nest's config and connection into the plain
 * `CostCenterService` (which the integration tests drive with a fake
 * registry) and turns its `null`s into 404s. Nothing about a provider is
 * named here; the registry is the one list, and the routes read it.
 */
@Injectable()
export class CmsCostCenterService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: CostCenterConfig,
  ) {}

  private get environment(): string {
    return this.config.APP_ENV ?? 'dev';
  }

  private center(): CostCenterService {
    return new CostCenterService(this.db, COST_REGISTRY, {
      environment: this.environment,
      ledgerEnabled: this.config.COST_LEDGER_ENABLED ?? false,
    });
  }

  overview(window: CostWindow): Promise<CostOverview> {
    return this.center().overview(window);
  }

  providers(window: CostWindow): Promise<ProviderCostRow[]> {
    return this.center().providers(window);
  }

  async provider(providerId: string, window: CostWindow): Promise<ProviderCostRow> {
    const row = await this.center().provider(providerId, window);
    if (row === null) {
      throw AppError.notFound('COST_PROVIDER_NOT_FOUND', `No registered provider ${providerId}`);
    }
    return row;
  }

  async service(
    providerId: string,
    serviceId: string,
    window: CostWindow,
  ): Promise<ServiceCostDetail> {
    const row = await this.center().service(providerId, serviceId, window);
    if (row === null) {
      throw AppError.notFound(
        'COST_SERVICE_NOT_FOUND',
        `No registered service ${serviceId} under provider ${providerId}`,
      );
    }
    return row;
  }

  testRuns(limit: number): Promise<TestRunRecord[]> {
    return new TestCostService(this.db).list({ environment: this.environment, limit });
  }

  async testRun(id: string): Promise<TestRunDetail> {
    const run = await new TestCostService(this.db).get(id);
    if (run === null) throw AppError.notFound('COST_TEST_RUN_NOT_FOUND', `No test run ${id}`);
    return run;
  }

  // ── manual costs (#382, epic §27) ──────────────────────────────────────────

  private manual(): ManualCostService {
    return new ManualCostService(this.db, COST_REGISTRY, {
      environment: this.environment,
      // #388 — the package declares what it needs written; `@gogo/modules`
      // supplies the writer that fills request id and admin IP from the
      // request context.
      audit: writeAudit,
    });
  }

  async manualItems(): Promise<{
    items: ManualCostItem[];
    eligibleServices: EligibleManualService[];
  }> {
    const svc = this.manual();
    return { items: await svc.list(), eligibleServices: svc.eligibleServices() };
  }

  async manualItem(id: string): Promise<ManualCostItem> {
    const item = await this.manual().get(id);
    if (item === null)
      throw AppError.notFound('COST_MANUAL_ITEM_NOT_FOUND', `No manual item ${id}`);
    return item;
  }

  createManualItem(input: ManualCostItemInput, actor: ManualCostActor): Promise<ManualCostItem> {
    return refused(() => this.manual().create(input, actor));
  }

  async updateManualItem(
    id: string,
    patch: ManualCostItemPatch,
    actor: ManualCostActor,
  ): Promise<ManualCostItem> {
    const item = await refused(() => this.manual().update(id, patch, actor));
    if (item === null)
      throw AppError.notFound('COST_MANUAL_ITEM_NOT_FOUND', `No manual item ${id}`);
    return item;
  }

  async removeManualItem(id: string, actor: ManualCostActor): Promise<void> {
    const removed = await this.manual().remove(id, actor);
    if (!removed) throw AppError.notFound('COST_MANUAL_ITEM_NOT_FOUND', `No manual item ${id}`);
  }
}

/** A refused manual-cost write is a 400 naming the field, not a 500. */
async function refused<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ManualCostError) {
      throw AppError.badRequest('COST_MANUAL_ITEM_INVALID', err.message, [
        { field: err.field, code: err.code, message: err.message },
      ]);
    }
    throw err;
  }
}
