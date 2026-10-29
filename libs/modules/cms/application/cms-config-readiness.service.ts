import { readFile, stat } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../shared/config';
import {
  CONFIG_CATALOGUE,
  buildConfigReadiness,
  parseProjection,
  type ConfigCatalogue,
  type ConfigReadiness,
  type ProjectionRead,
} from '../domain/config-readiness';

/**
 * GoGo-BE#727 (OPS-BE-002) — `GET /v1/cms/ops/config-readiness`.
 *
 * Reads the raw process environment (presence only) and the readiness
 * projection GoGo-Infra's deploy leaves at `SECRETS_READINESS_FILE`. Nothing
 * here calls AWS, and nothing here returns a value. A projection that is
 * absent or unreadable is a fact about the deploy, not an error of this
 * endpoint: `200` with `infra: null` and the reason.
 */

type ConfigReadinessConfig = { SECRETS_READINESS_FILE: string };

/** A projection is a few hundred names; anything near this is not one. */
export const PROJECTION_MAX_BYTES = 1024 * 1024;

@Injectable()
export class CmsConfigReadinessService {
  constructor(
    @Inject(CONFIG_CATALOGUE) private readonly catalogue: ConfigCatalogue,
    @Inject(APP_CONFIG) private readonly config: ConfigReadinessConfig,
  ) {}

  async readiness(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): Promise<ConfigReadiness> {
    return buildConfigReadiness({
      catalogue: this.catalogue,
      env,
      projection: await this.readProjection(),
    });
  }

  private async readProjection(): Promise<ProjectionRead> {
    const file = this.config.SECRETS_READINESS_FILE.trim();
    if (file === '') return { ok: false, reason: 'not_configured' };
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > PROJECTION_MAX_BYTES)
        return { ok: false, reason: 'invalid' };
      return parseProjection(await readFile(file, 'utf8'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false, reason: code === 'ENOENT' ? 'missing' : 'unreadable' };
    }
  }
}
