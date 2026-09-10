/**
 * GOGO-550 — `pnpm config:check`. Runs before a deploy swaps containers; see
 * `preflight.ts` for why the ordering is the whole point.
 *
 * Exit 0 prints the capability line the deploy log keeps. Exit 1 prints the
 * same message the API would have died with, while the old container is still
 * serving traffic.
 */
import { preflight } from './preflight';

const result = preflight(process.env);

if (!result.ok) {
  // eslint-disable-next-line no-console
  console.error(`config:check FAILED — ${result.problem}`);
  process.exit(1);
}

const on = Object.entries(result.capabilities)
  .filter(([, enabled]) => enabled)
  .map(([name]) => name);
const off = Object.entries(result.capabilities)
  .filter(([, enabled]) => !enabled)
  .map(([name]) => name);

// eslint-disable-next-line no-console
console.log(
  `config:check ok — enabled: ${on.join(', ') || 'none'}; disabled: ${off.join(', ') || 'none'}`,
);
