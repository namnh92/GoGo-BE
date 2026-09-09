import { categoryForGoogleType } from './google-types';
import { normalizeVietnamese, toSearchQuery } from '../../search/domain/normalize';
import { haversineMeters } from '../../suggestions/domain/hard-filter';

/**
 * PI-BE-005 / FR-INGEST-003/004 — candidate scoring for provider matches.
 * Weights come straight from the spec; thresholds are configurable so ops can
 * tighten them without a deploy.
 */

export const MATCH_WEIGHTS = {
  name: 0.5,
  district: 0.2,
  city: 0.15,
  category: 0.1,
  coordinate: 0.05,
} as const;

export const MATCH_THRESHOLDS = { auto: 0.9, confirm: 0.7 } as const;

export type MatchOutcome = 'RESOLVED_AUTOMATICALLY' | 'NEEDS_CONFIRMATION' | 'UNRESOLVED';

export type MatchReason =
  | 'EXACT_PROVIDER_ID'
  | 'EXACT_NAME_CITY'
  | 'MULTIPLE_BRANCHES'
  | 'DISTRICT_MISMATCH'
  | 'CITY_MISMATCH'
  | 'TYPE_MISMATCH'
  | 'LOW_CONFIDENCE'
  /** The link's Google feature id and this candidate's CID are the same place. */
  | 'CID_EXACT_MATCH'
  /** That candidate is not the one the text score ranked first. Recorded, not hidden. */
  | 'CID_OVERRODE_SCORE'
  /** The link names one place by id and a different one by CID. Nobody guesses. */
  | 'CID_IDENTITY_CONFLICT'
  /** The link named a place by CID and the search did not return it. */
  | 'CID_NOT_IN_CANDIDATES'
  /** The curated name and the link's own name point at different candidates. */
  | 'NAME_SOURCES_DISAGREE';

export type MatchInput = {
  /** Curated name — a CMS import column. Scored symmetrically. */
  name?: string | undefined;
  /**
   * Free-text search string lifted from a shared link. Spec §6.2 step 5 keeps
   * this separate from `name` on purpose; scored by coverage, never as a name.
   */
  query?: string | undefined;
  city?: string | undefined;
  district?: string | undefined;
  categoryKey?: string | undefined;
  /**
   * Where the input says the place **is** — an exact coordinate, never a map
   * viewport centre (#505). `place-resolver` fills this from `!8m2!3d…!4d…` or
   * a typed `?q=<lat>,<lng>`; the `@lat,lng,z` in a browser link is the camera
   * position and is used to bias the search, not to score a distance.
   */
  lat?: number | undefined;
  lng?: number | undefined;
  /**
   * The CID half of the Google feature id the link carried, in decimal.
   *
   * Identity, not similarity: when a candidate's own `googleMapsUri` names the
   * same CID, the two are the same Google record and no amount of name or
   * distance scoring can say otherwise. This is what makes an application share
   * link resolvable at all for a multi-branch brand, whose display name never
   * covers the query.
   */
  featureCid?: string | undefined;
};

export type MatchTarget = {
  googlePlaceId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  primaryType?: string | undefined;
  /**
   * The CID out of this candidate's `googleMapsUri`, in decimal, or null when
   * Google did not publish one. Compared against `MatchInput.featureCid`.
   */
  providerCid?: string | null | undefined;
};

/**
 * Matching tokens: unaccented words, punctuation removed, on both sides.
 *
 * Google display names routinely end in decoration — `Lacàph Coffee Experiences
 * Space 🇻🇳☕️` tokenises the emoji cluster as a word of its own — and counting
 * that as a token inflates the denominator of every comparison below (#311).
 *
 * #505 — the separator has to go too, and this is where the Google Maps
 * *application* share link was lost. It writes `?q=<name>, <full address>`, so
 * `normalizeVietnamese` (which folds accents and whitespace and nothing else)
 * produced the token `west,` — which is not `west`. `Sheraton Hanoi West`
 * against `Sheraton Hanoi West, 36 Lê Đức Thọ, Từ Liêm, Hà Nội, Việt Nam` came
 * to 0.667 instead of 1.0, under the 0.70 floor, for a comma. A browser link
 * escaped it only because `/maps/place/<Name>/` is one clean path segment.
 *
 * Punctuation is dropped rather than translated to a token boundary in one
 * step: `toSearchQuery` already replaces every non-letter, non-digit with a
 * space and collapses runs, which is exactly the same normalisation the SQL
 * side applies, so query and candidate meet in one space (SE-002).
 */
function tokens(value: string): Set<string> {
  return new Set(
    toSearchQuery(value)
      .split(' ')
      .filter((t) => t.length > 0),
  );
}

/** Token-set similarity over unaccented text — order-insensitive, 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.max(ta.size, tb.size);
}

/**
 * How much of the candidate's own name the search text accounts for.
 *
 * The symmetric measure above is the right question when both sides are names,
 * which is the CMS import case. It is the wrong question for a free-text query:
 * every locality token the user left in their link ("… Ho Chi Minh City")
 * enlarges the denominator, so the *better specified* the link, the lower it
 * scored — `Landmark 81 Ho Chi Minh City` against `Landmark 81` came to 0.333
 * and the whole match fell to 0.417, under the 0.70 floor (#311).
 *
 * Here only the candidate's side is the denominator: does its name appear in
 * what the user asked for? Extra query tokens are the address the user typed,
 * not evidence against the match. A candidate whose name is only partly present
 * still scores down, which is what keeps a loose provider hit out.
 */
export function nameCoverage(query: string, name: string): number {
  const tq = tokens(query);
  const tn = tokens(name);
  if (tq.size === 0 || tn.size === 0) return 0;
  let shared = 0;
  for (const t of tn) if (tq.has(t)) shared += 1;
  return shared / tn.size;
}

function containsNormalized(haystack: string, needle?: string): boolean {
  if (!needle) return false;
  return normalizeVietnamese(haystack).includes(normalizeVietnamese(needle));
}

export type ScoredMatch = {
  target: MatchTarget;
  confidence: number;
  reasons: MatchReason[];
};

/**
 * #473 — a dimension the input says nothing about leaves the average entirely,
 * rather than sitting in it at a neutral 0.5.
 *
 * Neutral-0.5 was meant not to punish an unknown, and inside the score it does
 * not. At the threshold it does: 0.5 on a 0.2-weight field still forfeits 0.1
 * against a match that could have been perfect. A Google Maps link carries a
 * name and a coordinate and never a district or a category — those are bulk
 * import's CSV columns — so its ceiling was
 *
 *     0.50·1 + 0.20·0.5 + 0.15·1 + 0.10·0.5 + 0.05·1 = 0.85
 *
 * against an `auto` threshold of 0.90. **No link could ever auto-resolve.**
 * Every one of them came back as "pick a branch", usually with one branch.
 * GoGo-BE#311 fought a symptom of this and fixed `nameCoverage`; the ceiling
 * outlived it.
 *
 * Normalising over the informed weights cuts both ways, which is what says it
 * is the right transform rather than a thumb on the scale: a weak name no
 * longer gets propped up by three neutral dimensions either (0.4 alone now
 * scores 0.4, where it used to reach 0.425).
 *
 * The thresholds do not move, and neither does the ambiguity rule below — two
 * candidates within 0.05 are still a question for a person.
 */
type Dimension = { weight: number; score: number; informed: boolean };

function weightedConfidence(dimensions: Dimension[]): number {
  let total = 0;
  let weight = 0;
  for (const d of dimensions) {
    if (!d.informed) continue;
    total += d.weight * d.score;
    weight += d.weight;
  }
  // Nothing to go on. `resolveIdentified` refuses to search without a query, so
  // this is unreachable through the API — but the function is exported, and
  // dividing by zero would answer `NaN`, which compares false against every
  // threshold and would quietly read as "not confident" instead of "no idea".
  if (weight === 0) return 0;
  return round3(total / weight);
}

export function scoreMatch(input: MatchInput, target: MatchTarget): ScoredMatch {
  const reasons: MatchReason[] = [];

  /**
   * #505 — two namings of one place, and the candidate need only match one.
   *
   * `name` is a curated column: a CSV row, a sheet cell, something a person
   * typed. `query` is the text Google itself put in the link. They are scored
   * by different measures on purpose (see `nameCoverage`), and until now the
   * curated one simply *replaced* the link's — so the same URL resolved
   * through `POST /places/resolve-google-maps-link` and failed through
   * `/cms/place-imports`, because the sheet spelled the place differently
   * from Google. The same link, two answers, and neither path could see the
   * other's evidence.
   *
   * The better of the two is the one that stands: a candidate whose name the
   * editor wrote *or* whose name the link carried is evidence for the same
   * conclusion, and requiring it to satisfy both makes a correct row fail for
   * a spelling. It cannot promote a candidate that matches neither — the max
   * of two low scores is still low — and the branch tests below hold.
   */
  const named = Boolean(input.name ?? input.query);
  const nameScore = Math.max(
    input.name ? nameSimilarity(input.name, target.name) : 0,
    input.query ? nameCoverage(input.query, target.name) : 0,
  );

  const districtHit = containsNormalized(target.address, input.district);
  if (input.district && !districtHit) reasons.push('DISTRICT_MISMATCH');

  const cityHit = containsNormalized(target.address, input.city);
  if (input.city && !cityHit) reasons.push('CITY_MISMATCH');

  // Informed only when both sides say something. A Google type GoGo has no
  // category for means "cannot tell" — scoring it as a mismatch would penalise
  // every place outside the eight categories for existing, and scoring it
  // neutral would hold back a row that matched everything it did know.
  let categoryScore = 0;
  let categoryKnown = false;
  if (input.categoryKey && target.primaryType) {
    const implied = categoryForGoogleType(target.primaryType);
    if (implied) {
      categoryKnown = true;
      const hit = implied === input.categoryKey;
      categoryScore = hit ? 1 : 0;
      if (!hit) reasons.push('TYPE_MISMATCH');
    }
  }

  const located = input.lat !== undefined && input.lng !== undefined;
  let coordinateScore = 0;
  if (located) {
    const d = haversineMeters({ lat: input.lat!, lng: input.lng! }, target);
    coordinateScore = d <= 150 ? 1 : d <= 1000 ? 0.6 : d <= 5000 ? 0.2 : 0;
  }

  const confidence = weightedConfidence([
    { weight: MATCH_WEIGHTS.name, score: nameScore, informed: named },
    {
      weight: MATCH_WEIGHTS.district,
      score: districtHit ? 1 : 0,
      informed: Boolean(input.district),
    },
    { weight: MATCH_WEIGHTS.city, score: cityHit ? 1 : 0, informed: Boolean(input.city) },
    { weight: MATCH_WEIGHTS.category, score: categoryScore, informed: categoryKnown },
    { weight: MATCH_WEIGHTS.coordinate, score: coordinateScore, informed: located },
  ]);

  if (nameScore >= 0.99 && cityHit) reasons.unshift('EXACT_NAME_CITY');
  if (confidence < MATCH_THRESHOLDS.confirm) reasons.push('LOW_CONFIDENCE');

  return { target, confidence, reasons };
}

export type MatchDecision = {
  outcome: MatchOutcome;
  best?: ScoredMatch;
  candidates: ScoredMatch[];
  reasons: MatchReason[];
};

/**
 * Is `a` a strictly shorter naming of the same thing as `b`?
 *
 * #473 — the score gap alone cannot tell a brand from a place. Ask Google for
 * "Highlands Coffee" and one candidate is called exactly that while the rest
 * are "Highlands Coffee Hai Bà Trưng" and friends. Coverage measures how much
 * of the *candidate's* name the query accounts for, so the brand-named branch
 * scores 1.0 and every real branch scores less — a wide gap, no ambiguity by
 * the 0.05 rule, and the first shop in the list silently wins the chain.
 *
 * The tell is containment in the other direction: the winner's name being a
 * strict subset of another candidate's means the query named the brand and the
 * others are its branches. "Landmark 81" inside "CGV Vincom Center Landmark 81"
 * is the same shape.
 *
 * Not symmetric, and not a similarity: "Lacàph Coffee Experiences Space" is not
 * inside "Lacàph Coffee Bar", so naming one of two differently-named places
 * still resolves.
 */
function isShorterNamingOf(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || ta.size >= tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}

/**
 * Ranks candidates and applies the thresholds. Two candidates within 0.05 of
 * each other are branches of the same brand — never auto-resolve those, a
 * human picks (FR-INGEST-004) — and neither is a winner whose name is merely
 * the brand the others carry.
 */
export function decideMatch(
  input: MatchInput,
  targets: MatchTarget[],
  thresholds: { auto: number; confirm: number } = MATCH_THRESHOLDS,
): MatchDecision {
  if (targets.length === 0) {
    return { outcome: 'UNRESOLVED', candidates: [], reasons: ['LOW_CONFIDENCE'] };
  }
  const scored = targets
    .map((t) => scoreMatch(input, t))
    .sort(
      (a, b) =>
        b.confidence - a.confidence || (a.target.googlePlaceId < b.target.googlePlaceId ? -1 : 1),
    );
  /**
   * #505 — identity first, similarity second.
   *
   * A Google Maps share link carries the place's feature id (`ftid=` from the
   * application, `!1s0x…:0x…` from the browser) and Place Details answers with
   * the same number inside `googleMapsUri`. When those agree the two are the
   * same Google record — a fact, where every dimension above is an estimate.
   *
   * This is what a multi-branch brand needs. `Cafe Phê La` against the
   * candidate Google actually returns, `Phê La Xuân Diệu`, covers two name
   * tokens of four; the coordinate dimension carries 0.05 of the weight, so no
   * honest scoring of *text* reaches 0.90 — and the alternative on the table
   * was lowering the threshold, which would have let every weak match through
   * to buy this one.
   *
   * The scored list is still computed, still returned, and the reasons still
   * say when identity and score disagreed. Nothing is hidden; the ranking is
   * simply not the thing being asked.
   */
  const cidMatches = input.featureCid
    ? scored.filter((s) => s.target.providerCid && s.target.providerCid === input.featureCid)
    : [];
  if (cidMatches.length === 1) {
    const identified = cidMatches[0]!;
    const overrode = identified.target.googlePlaceId !== scored[0]!.target.googlePlaceId;
    const reasons: MatchReason[] = [
      'CID_EXACT_MATCH',
      ...(overrode ? (['CID_OVERRODE_SCORE'] as const) : []),
    ];
    return {
      outcome: 'RESOLVED_AUTOMATICALLY',
      best: { target: identified.target, confidence: 1, reasons },
      candidates: scored.slice(0, 5),
      reasons,
    };
  }

  /**
   * The link named a place, and none of the candidates is it.
   *
   * At least one candidate published a CID, so the comparison was real and it
   * failed — these are not the place the link points at, whatever they score.
   * The honest answer is to hand them to a person rather than to auto-resolve
   * onto an identity the link contradicts, which is the silent acceptance
   * `CID_IDENTITY_CONFLICT` refuses one level up.
   *
   * Seen on a real link: `Bến Bạch Đằng` in Ho Chi Minh City is Google's
   * *fifth* text-search result for its own name, behind a park, a pier and a
   * water-bus stop within 300 m, so a three-candidate window cannot contain it.
   * Widening the window costs a billed Details call per extra candidate, so
   * what changes here is only that GoGo stops claiming to have found it.
   */
  const comparable = input.featureCid
    ? scored.some((s) => s.target.providerCid !== null && s.target.providerCid !== undefined)
    : false;
  const missedByCid = Boolean(input.featureCid) && comparable && cidMatches.length === 0;

  /**
   * #505 — the two namings disagree about *which* candidate, not about how
   * well one matches.
   *
   * Scoring the better of the curated name and the link's own is what stopped
   * a sheet's spelling from failing a correct row. It must not become a way
   * for that spelling to *choose*: a sheet saying "Phê La Núi Trúc" against a
   * link pointing at Xuân Diệu is two people naming two different places, and
   * `max` would quietly hand the row to whichever scored higher.
   *
   * So when both sources are present and each ranks a different candidate
   * first, nobody auto-resolves. The candidates are still returned and a
   * person picks — the same treatment two branches of one brand already get,
   * for the same reason: the input does not say which.
   *
   * This cannot fire when the link states an identity: a CID match returns
   * above, and a CID that matched nothing has already blocked auto-resolution.
   */
  const namesDisagree =
    input.name !== undefined &&
    input.query !== undefined &&
    bestBy(targets, (t) => nameSimilarity(input.name!, t.name)) !==
      bestBy(targets, (t) => nameCoverage(input.query!, t.name));

  const best = scored[0]!;
  const runnerUp = scored[1];
  const ambiguous =
    (runnerUp !== undefined && best.confidence - runnerUp.confidence < 0.05) ||
    scored.slice(1).some((other) => isShorterNamingOf(best.target.name, other.target.name));
  const reasons = [...best.reasons];
  if (ambiguous) reasons.unshift('MULTIPLE_BRANCHES');
  if (missedByCid) reasons.unshift('CID_NOT_IN_CANDIDATES');
  if (namesDisagree) reasons.unshift('NAME_SOURCES_DISAGREE');

  let outcome: MatchOutcome;
  if (best.confidence >= thresholds.auto && !ambiguous && !missedByCid && !namesDisagree) {
    outcome = 'RESOLVED_AUTOMATICALLY';
  } else if (best.confidence >= thresholds.confirm) outcome = 'NEEDS_CONFIRMATION';
  else outcome = 'UNRESOLVED';

  return { outcome, best, candidates: scored.slice(0, 5), reasons };
}

/**
 * An identity the URL stated, resolved without scoring anything.
 *
 * `EXACT_PROVIDER_ID` is a Place ID read straight out of the link.
 * `CID_EXACT_MATCH` is the same strength of claim reached differently — the
 * link's `ftid` and a search hit's own `googleMapsUri` name the same Google
 * record — and the two are kept apart so a reader can tell which evidence the
 * resolution stood on.
 */
export function exactProviderMatch(
  target: MatchTarget,
  via: 'EXACT_PROVIDER_ID' | 'CID_EXACT_MATCH' = 'EXACT_PROVIDER_ID',
): MatchDecision {
  return {
    outcome: 'RESOLVED_AUTOMATICALLY',
    best: { target, confidence: 1, reasons: [via] },
    candidates: [{ target, confidence: 1, reasons: [via] }],
    reasons: [via],
  };
}

/**
 * Which candidate a single measure ranks first, by id so the answer is stable
 * when two score the same. `null` when nothing scores above zero — a measure
 * that recognises none of them has no opinion to disagree with.
 */
function bestBy(targets: MatchTarget[], score: (t: MatchTarget) => number): string | null {
  let winner: MatchTarget | null = null;
  let best = 0;
  for (const t of targets) {
    const value = score(t);
    if (
      value > best ||
      (value === best && winner !== null && t.googlePlaceId < winner.googlePlaceId)
    ) {
      if (value > 0) {
        best = value;
        winner = t;
      }
    }
  }
  return winner?.googlePlaceId ?? null;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
