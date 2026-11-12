/** Match raw, vi dot-grouped and en comma-grouped integer minor-unit amounts.
 * Strip volatile UUIDs/timestamps from the subject before using this leak guard.
 * Match whole numeric tokens, including when surrounded by text or punctuation.
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
  // All alternatives must reject adjacent digits or a digit across a grouping
  // separator. Sentence punctuation is allowed unless it continues a number.
  return new RegExp(`(?<!\\d)(?<!\\d[.,])(?:${[...new Set(patterns)].join('|')})(?!\\d|[.,]\\d)`);
}
