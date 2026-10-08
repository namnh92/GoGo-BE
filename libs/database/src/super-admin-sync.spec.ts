import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { formatSyncFailure, SuperAdminSyncConflict, SuperAdminSyncError } from './super-admin-sync';

/**
 * GoGo-BE#687 review F-07 — the one line `cms:sync-super-admin` prints on
 * failure. The deploy log is read by whoever runs the deploy; the super admin's
 * address is not for them.
 */

const ADDRESS = 'boss@example.com';

describe('formatSyncFailure (#687 F-07)', () => {
  it("prints the sync's own refusal as written: operator guidance, no address in it", () => {
    const line = formatSyncFailure(new SuperAdminSyncConflict());
    expect(line).toContain('belongs to a staff account');
    expect(line).toContain('nothing was changed');
    expect(line).not.toContain(ADDRESS);
  });

  it('prints a configuration error as written', () => {
    expect(
      formatSyncFailure(new SuperAdminSyncError('cms:sync-super-admin: DATABASE_URL is required')),
    ).toBe('cms:sync-super-admin: DATABASE_URL is required');
  });

  it('reduces a DrizzleQueryError, whose message holds the bound address, to class and SQLSTATE', () => {
    const err = new DrizzleQueryError(
      'insert into "admin_users" ("email", "role") values ($1, $2)',
      [ADDRESS, 'super_admin'],
      Object.assign(new Error(`duplicate key value violates unique constraint`), {
        code: '23505',
        detail: `Key (lower(email))=(${ADDRESS}) already exists.`,
      }),
    );
    expect(err.message).toContain(ADDRESS);
    const line = formatSyncFailure(err);
    expect(line).toBe('cms:sync-super-admin failed: DrizzleQueryError <- Error 23505');
    expect(line).not.toContain(ADDRESS);
  });

  it('names a non-error throw by type only', () => {
    expect(formatSyncFailure(`refused for ${ADDRESS}`)).toBe('cms:sync-super-admin failed: string');
  });
});
