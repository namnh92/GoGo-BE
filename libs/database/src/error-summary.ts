/**
 * GoGo-BE#687 review F-07 — what a database error may say in a log line.
 *
 * Drizzle's `DrizzleQueryError` puts the bound parameters into its message
 * (`Failed query: … params: <email>`), and that message is also the first line
 * of its stack. `pg`'s `DatabaseError` carries row echoes in `detail`
 * (`Key (lower(email))=(<email>) already exists`). Whatever wraps one of them
 * keeps it as `cause`, so printing an error from the super admin sync or the
 * boot erase gate — message, stack, `cause` — prints the super admin's address
 * (`.claude/rules/security.md`: logs never contain PII).
 *
 * This reduces any thrown value to an allowlist: the error's class name and,
 * when it has one, its `code` — a PostgreSQL SQLSTATE such as `08006`, or a
 * Node errno such as `ECONNRESET` — down the `cause` chain to a bounded depth.
 * Never the message, the stack, `detail`, `params` or `query`. Both fields are
 * pattern-checked, so a value that is not a plain token is dropped rather than
 * printed.
 */

export type ErrorFacts = { name: string; code?: string };

/** How far down `cause` to look. Bounds a cyclic chain as well. */
export const ERROR_SUMMARY_MAX_DEPTH = 4;

/** SQLSTATE (`23505`, `08006`), Node errno (`ECONNREFUSED`): upper-case tokens only. */
const SAFE_CODE = /^[A-Z0-9_]{1,32}$/;
/** A class name. `@` and `.` never pass, so an address can never ride on `name`. */
const SAFE_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

const safeName = (value: unknown): string | undefined =>
  typeof value === 'string' && SAFE_NAME.test(value) ? value : undefined;

function factsOf(value: unknown): ErrorFacts {
  if (typeof value !== 'object' || value === null) return { name: typeof value };
  const record = value as { constructor?: { name?: unknown }; name?: unknown; code?: unknown };
  // The constructor first: `DrizzleQueryError` never sets `name`, and pg's
  // `DatabaseError` sets it to the protocol message kind (`error`).
  const name = safeName(record.constructor?.name) ?? safeName(record.name) ?? 'Error';
  const code = record.code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? { name, code } : { name };
}

/** The allowlisted facts of `err` and of each `cause` under it, outermost first. */
export function errorFacts(err: unknown): ErrorFacts[] {
  const facts: ErrorFacts[] = [];
  let current: unknown = err;
  for (
    let depth = 0;
    depth < ERROR_SUMMARY_MAX_DEPTH && current !== undefined && current !== null;
    depth += 1
  ) {
    facts.push(factsOf(current));
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return facts;
}

/**
 * One line for an operator: `DrizzleQueryError <- DatabaseError 08006`,
 * `Error ECONNREFUSED`. Safe to put in a log line or an error message.
 */
export function summarizeError(err: unknown): string {
  return errorFacts(err)
    .map((f) => (f.code ? `${f.name} ${f.code}` : f.name))
    .join(' <- ');
}
