import { createHash } from 'node:crypto';

/**
 * SG-010 (#49) — deterministic A/B assignment.
 *
 * The subject is the **room**, never the member. A group room where two people
 * are in different variants would compare two different plans and call it one
 * experiment; worse, the room would see an itinerary that depends on who
 * asked. Assignment is per room, so everyone in it sees one system.
 *
 * Computed from a hash rather than stored: the same room always lands in the
 * same variant without a lookup, and there is no row whose loss would silently
 * reassign a room mid-experiment. Which variant a run actually used is
 * recorded on the run — that is the audit trail, and it is the honest one,
 * because it says what happened rather than what should have.
 */
export const CONTROL = 'control';

/** Stable in [0, 1). Salted by key so two experiments do not correlate. */
export function bucket(experimentKey: string, subjectId: string): number {
  const digest = createHash('sha256').update(`${experimentKey}:${subjectId}`).digest();
  // 32 bits is far more resolution than any split needs, and avoids the
  // modulo bias a single byte would introduce.
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Picks a variant by weight. Weights need not sum to 1: whatever is left over
 * goes to control, so a half-configured experiment exposes fewer subjects
 * rather than more.
 */
export function assign(
  experimentKey: string,
  subjectId: string,
  variants: Record<string, number>,
): string {
  const entries = Object.entries(variants)
    .filter(([name, weight]) => name !== CONTROL && weight > 0)
    // Sorted so the mapping from bucket to variant does not depend on key
    // insertion order — a room must not move because the config was rewritten.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const point = bucket(experimentKey, subjectId);
  let cursor = 0;
  for (const [name, weight] of entries) {
    cursor += weight;
    if (point < cursor) return name;
  }
  return CONTROL;
}
