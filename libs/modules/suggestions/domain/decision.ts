/** SG-006 — deterministic decision rules for couple match and group vote. */

export type VoteRecord = {
  memberId: string;
  placeId: string;
  value: 'yes' | 'no' | 'star';
};

const POINTS: Record<VoteRecord['value'], number> = { star: 2, yes: 1, no: 0 };

/**
 * Couple `match`: the winning place is one every member voted yes/star on.
 * Ties (several full matches) resolve by candidate rank order.
 */
export function coupleMatches(votes: VoteRecord[], activeMemberIds: string[]): string[] {
  const byPlace = new Map<string, Set<string>>();
  for (const v of votes) {
    if (v.value === 'no') continue;
    const set = byPlace.get(v.placeId) ?? new Set();
    set.add(v.memberId);
    byPlace.set(v.placeId, set);
  }
  return [...byPlace.entries()]
    .filter(([, members]) => activeMemberIds.every((id) => members.has(id)))
    .map(([placeId]) => placeId);
}

export type TallyRow = {
  placeId: string;
  points: number;
  yes: number;
  star: number;
  no: number;
};

/** Group `vote`: star=2, yes=1, no=0. Deterministic ordering for ties. */
export function tallyVotes(votes: VoteRecord[]): TallyRow[] {
  const rows = new Map<string, TallyRow>();
  for (const v of votes) {
    const row = rows.get(v.placeId) ?? { placeId: v.placeId, points: 0, yes: 0, star: 0, no: 0 };
    row.points += POINTS[v.value];
    row[v.value] += 1;
    rows.set(v.placeId, row);
  }
  return [...rows.values()].sort((a, b) => b.points - a.points || (a.placeId < b.placeId ? -1 : 1));
}

/**
 * Winner resolution: highest points; ties broken by candidate rank (lower is
 * better) so the tie result is explainable; the host can override in `host`
 * decision mode (FR-SUG-004 tie policy).
 */
export function resolveWinner(
  tally: TallyRow[],
  rankByPlaceId: Map<string, number>,
): { winnerPlaceId: string | null; tie: boolean; tiedPlaceIds: string[] } {
  if (tally.length === 0) return { winnerPlaceId: null, tie: false, tiedPlaceIds: [] };
  const top = tally[0]!.points;
  const tied = tally.filter((t) => t.points === top);
  if (tied.length === 1) {
    return { winnerPlaceId: tied[0]!.placeId, tie: false, tiedPlaceIds: [] };
  }
  const sorted = [...tied].sort(
    (a, b) =>
      (rankByPlaceId.get(a.placeId) ?? 1e9) - (rankByPlaceId.get(b.placeId) ?? 1e9) ||
      (a.placeId < b.placeId ? -1 : 1),
  );
  return {
    winnerPlaceId: sorted[0]!.placeId,
    tie: true,
    tiedPlaceIds: sorted.map((t) => t.placeId),
  };
}
