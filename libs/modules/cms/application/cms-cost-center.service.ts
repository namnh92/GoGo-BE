import { Inject, Injectable } from '@nestjs/common';
import { type Db } from '@gogo/database';
import {
  CostCenterService,
  type CostOverview,
  type CostWindow,
  type ProviderCostRow,
  type ServiceCostDetail,
} from '../../cost/application/cost-center.service';
import {
  TestCostService,
  type TestRunDetail,
  type TestRunRecord,
} from '../../cost/application/test-cost.service';
import { COST_REGISTRY } from '../../cost/domain/registry';
import { AppError } from '../../shared/app-error';
import { APP_CONFIG } from '../../shared/config';
import { DB } from '../../shared/tokens';

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
}
