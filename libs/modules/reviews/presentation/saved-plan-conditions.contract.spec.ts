import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const SPEC = path.resolve(__dirname, '../../../../openapi/gogo.v1.yaml');

interface SchemaObject {
  type?: string | string[];
  minimum?: number;
  required?: string[];
  properties?: Record<string, SchemaObject>;
}

const doc = parseYaml(readFileSync(SPEC, 'utf8')) as {
  info: { version: string };
  components: { schemas: Record<string, SchemaObject> };
};

describe('GoGo-BE#759 saved plan condition facts', () => {
  it('adds optional condition-change facts to saved items', () => {
    const savedItem = doc.components.schemas.SavedItem!;

    expect(savedItem.properties?.conditionsChanged?.type).toBe('boolean');
    expect(savedItem.properties?.planConstraintVersion).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    expect(savedItem.properties?.currentConstraintVersion).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    expect(savedItem.required ?? []).not.toContain('conditionsChanged');
    expect(savedItem.required ?? []).not.toContain('planConstraintVersion');
    expect(savedItem.required ?? []).not.toContain('currentConstraintVersion');
  });

  it('bumps the alpha contract once', () => {
    expect(doc.info.version).toBe('7.8.0-alpha.1');
  });
});
