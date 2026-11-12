/** Match raw, vi dot-grouped and en comma-grouped integer minor-unit amounts.
 * Strip volatile UUIDs/timestamps from the subject before using this leak guard.
 * Substring matching deliberately preserves the existing guards' strictness.
 */
export function minorUnitAmounts(...amounts: readonly number[]): RegExp {
  const patterns = amounts.flatMap((amount) => {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new RangeError('Expected a non-negative safe integer minor-unit amount');
    }
    const raw = String(amount);
    return [
      raw,
      raw.replace(/\B(?=(\d{3})+(?!\d))/g, '\\.'),
      raw.replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    ];
  });
  if (!patterns.length) throw new RangeError('Expected at least one minor-unit amount');
  return new RegExp(`(?:${[...new Set(patterns)].join('|')})`);
}
