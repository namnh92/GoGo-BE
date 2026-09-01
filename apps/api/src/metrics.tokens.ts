/** DI token for the scrapeable metric registry (PI-SRE-001). */
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');

/**
 * #335 — the log + registry pair, before the usage ledger is teed onto it.
 *
 * The ledger reports its own flush outcomes as metrics. Handing it the fully
 * assembled `METRICS` would make it a consumer of the stream it writes, which
 * is a cycle in the DI graph and a re-entrancy hazard at runtime.
 */
export const METRICS_BASE = Symbol('METRICS_BASE');
