import { describe, expect, it } from 'vitest';
import { schema, type Db } from '@gogo/database';
import { AppError } from '../../shared/app-error';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe';
import { flagSchema } from '../presentation/cms.controllers';
import { CmsOpsService } from './cms-ops.service';

/**
 * GoGo-BE#713 Q7 — a feature-flag write records *why*, not only what changed.
 *
 * Contract 2.0.0-alpha.3 adds an optional `reason` to
 * `PUT /cms/feature-flags/{key}`: validated (trimmed, 3–500, the bound every
 * other audited CMS write uses) when present, stored in the existing
 * `feature_flag.set` audit entry, and still optional so older writers keep
 * working until a later version makes it required.
 */

type Insert = { table: unknown; values: Record<string, unknown> };

function fakeDb() {
  const inserts: Insert[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const done = Promise.resolve();
        return Object.assign(done, { onConflictDoUpdate: async () => undefined });
      },
    }),
  };
  return { db: db as unknown as Db, inserts };
}

const auditOf = (inserts: Insert[]) => {
  const row = inserts.find((i) => i.table === schema.auditLogs);
  expect(row, 'an audit row is written').toBeDefined();
  return row!.values as { action: string; diff: Record<string, unknown> };
};

const pipe = new ZodValidationPipe(flagSchema);

describe('PUT /cms/feature-flags/{key} reason (GoGo-BE#713 Q7)', () => {
  it('stores the reason in the feature_flag.set audit entry', async () => {
    const { db, inserts } = fakeDb();
    const body = pipe.transform({
      enabled: false,
      reason: '  Provider incident — switching the AI fallback off  ',
    });
    await new CmsOpsService(db).setFeatureFlag('admin-1', 'feature_ai_recommendation', body);

    const audit = auditOf(inserts);
    expect(audit.action).toBe('feature_flag.set');
    expect(audit.diff.reason).toBe('Provider incident — switching the AI fallback off');
    expect(audit.diff.after).toEqual({ enabled: false, value: null });
  });

  it('still accepts a write without a reason (older writers) and records none', async () => {
    const { db, inserts } = fakeDb();
    const body = pipe.transform({ enabled: true });
    await new CmsOpsService(db).setFeatureFlag('admin-1', 'feature_ai_recommendation', body);
    expect(auditOf(inserts).diff).not.toHaveProperty('reason');
  });

  it.each([
    ['blank after trimming', '      '],
    ['shorter than 3 after trimming', ' ab '],
    ['longer than 500', 'x'.repeat(501)],
    ['not a string', 42],
  ])('refuses a reason that is %s with VALIDATION_FAILED on `reason`', (_label, reason) => {
    let thrown: unknown;
    try {
      pipe.transform({ enabled: true, reason });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.options.fieldErrors?.map((f) => f.field)).toEqual(['reason']);
  });

  it('accepts the bounds exactly (3 and 500 characters)', () => {
    expect(pipe.transform({ enabled: true, reason: 'abc' }).reason).toBe('abc');
    expect(pipe.transform({ enabled: true, reason: 'y'.repeat(500) }).reason).toHaveLength(500);
  });
});
