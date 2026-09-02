/**
 * COST-BE-015 (#367) — epic §6, the capability model.
 *
 * A capability is a thing the Cost Center can *do* for a provider, and the
 * registry is where a provider says which of them it supports. Generic code
 * discovers behaviour by asking the registry, never by comparing a provider
 * id to a string: `if (provider === 'google')` is the pattern epic §44.3
 * forbids, and every capability below exists so that the question can be
 * asked as `registry.hasCapability(id, 'QUOTA')` instead.
 *
 * The list is the epic's, verbatim. Adding a capability is an epic change,
 * not a convenience.
 */
export const CAPABILITIES = [
  /** Usage (requests, commands, bytes, minutes…) is collected for this provider. */
  'USAGE_COLLECTOR',
  /** The provider's own invoice or billing export is read back. */
  'ACTUAL_COST_COLLECTOR',
  /** Usage × a pricing rule yields an estimate. */
  'ESTIMATED_COST',
  /** A recurring fee that needs no usage (a subscription). */
  'FIXED_COST',
  /** Cost entered by hand in the CMS. */
  'MANUAL_COST',
  /** Free-tier / quota headroom is observable. */
  'QUOTA',
  /** A spend ceiling can be enforced before the call. */
  'BUDGET',
  /** A test run can measure a before/after usage delta. */
  'TEST_RUN_DELTA',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}
