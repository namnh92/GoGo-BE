import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { CmsCatalogController } from './cms.controllers';
import { ADMIN_ROLES_KEY } from './admin.guard';
import { createLogger, errorSerializer } from '@gogo/observability';
const spec = parse(readFileSync(resolve(__dirname, '../../../../openapi/gogo.v1.yaml'), 'utf8'));

describe('S5 alias additive contract and privacy boundary', () => {
  it('adds aliases to CMS read/update only, with independent evidence and no new requirements on existing PATCH callers', () => {
    expect(spec.info.version).toBe('11.0.0-alpha.1');
    const body =
      spec.paths['/cms/places/{id}'].patch.requestBody.content['application/json'].schema;
    expect(body.required).toBeUndefined();
    expect(body.properties.aliases.$ref).toBe('#/components/schemas/CmsPlaceAliases');
    expect(body.properties.aliasProvenance.$ref).toBe('#/components/schemas/CmsAliasProvenance');
    expect(spec.components.schemas.CmsPlaceDetail.required).toContain('aliases');
    expect(spec.components.schemas.CmsPlaceAliases.maxItems).toBe(20);
    expect(spec.components.schemas.CmsPlaceAliases.items.maxLength).toBe(120);
    expect(spec.components.schemas.CmsAliasProvenance.required).toEqual([
      'sourceType',
      'sourceReference',
      'collectedAt',
    ]);
    expect(spec.components.schemas.CmsAliasProvenance.properties.sourceType.enum).toEqual([
      'editorial',
    ]);
    expect(Reflect.getMetadata(ADMIN_ROLES_KEY, CmsCatalogController)).toEqual(['editor']);
  });
  it('SQL errors and CMS request serialization do not emit raw alias parameters or bodies', () => {
    const alias = 'Tiệm Bánh Cô An';
    const error = Object.assign(
      new Error(`Failed query: insert into place_aliases values ($1)\nparams: ${alias}`),
      { params: [alias] },
    );
    expect(JSON.stringify(errorSerializer(error))).not.toContain(alias);
    for (const detail of [
      `Key (place_id, alias_normalized)=(fixture, ${alias}) already exists.`,
      `Failing row contains (fixture, ${alias}).`,
    ]) {
      const database = Object.assign(new Error('constraint violation'), { detail });
      expect(JSON.stringify(errorSerializer(database))).not.toContain(alias);
    }
    let output = '';
    const logger = createLogger({
      name: 's5-test',
      level: 'info',
      destination: {
        write: (chunk) => {
          output += chunk;
        },
      },
    });
    logger.info({
      req: {
        method: 'PATCH',
        url: '/v1/cms/places/fixture',
        headers: {},
        body: { aliases: [alias] },
      },
    });
    expect(output).not.toContain(alias);
  });
});
