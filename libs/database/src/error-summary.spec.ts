import { DrizzleQueryError } from 'drizzle-orm';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ERROR_SUMMARY_MAX_DEPTH, errorFacts, summarizeError } from './error-summary';

/**
 * GoGo-BE#687 review F-07 — an error summary names the class and the code,
 * and nothing that could carry the super admin's address.
 */

const ADDRESS = 'boss@example.com';

/** The shape pg-protocol throws: `name` is the message kind, `code` the SQLSTATE. */
class DatabaseError extends Error {
  code = '08006';
  detail = `Key (lower(email))=(${ADDRESS}) already exists.`;
  constructor() {
    super('terminating connection due to administrator command');
    this.name = 'error';
  }
}

const drizzleFailure = () =>
  new DrizzleQueryError(
    'select "id" from "admin_users" where lower("email") = $1',
    [ADDRESS],
    new DatabaseError(),
  );

describe('summarizeError (#687 F-07)', () => {
  it('a DrizzleQueryError carries the address in its message and stack — the summary does not', () => {
    const err = drizzleFailure();
    // The premise: everything the raw error renders to leaks.
    expect(err.message).toContain(ADDRESS);
    expect(err.stack).toContain(ADDRESS);
    expect(inspect(err, { depth: 10 })).toContain(ADDRESS);

    const summary = summarizeError(err);
    expect(summary).toBe('DrizzleQueryError <- DatabaseError 08006');
    expect(summary).not.toContain(ADDRESS);
    expect(summary).not.toContain('example');
  });

  it('a Node socket error is its class and errno', () => {
    expect(
      summarizeError(
        Object.assign(new Error(`connect ECONNREFUSED ${ADDRESS}`), { code: 'ECONNREFUSED' }),
      ),
    ).toBe('Error ECONNREFUSED');
  });

  it('prefers the constructor name over a `name` the thrower set', () => {
    // pg sets `name = "error"`; the class is the useful fact.
    expect(errorFacts(new DatabaseError())).toEqual([{ name: 'DatabaseError', code: '08006' }]);
  });

  it('drops a code or a name that is not a plain token, rather than printing it', () => {
    const err = Object.assign(new Error('x'), { code: `mail:${ADDRESS}` });
    err.name = ADDRESS;
    expect(summarizeError(err)).toBe('Error');
    expect(summarizeError(Object.assign(new Error('x'), { code: 23505 }))).toBe('Error');
  });

  it('a thrown non-error is named by type only, whatever it holds', () => {
    expect(summarizeError(ADDRESS)).toBe('string');
    expect(summarizeError({ email: ADDRESS })).toBe('Object');
    expect(summarizeError(undefined)).toBe('');
    expect(summarizeError(null)).toBe('');
  });

  it('walks the cause chain to a bound, so a cycle ends', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(errorFacts(a)).toHaveLength(ERROR_SUMMARY_MAX_DEPTH);
    expect(summarizeError(a)).toBe('Error <- Error <- Error <- Error');
  });
});
