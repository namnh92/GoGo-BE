/**
 * PR3 / COST-BE-003 (#336) — the pinned scenarios of plan §4, driven over the
 * public API.
 *
 * Every input is a fixture, never a literal in this file. That is what makes
 * "two consecutive runs agree within ±1" a property of the system rather than
 * of whoever ran it: the URLs, the ids, the queries and the twenty sheet rows
 * are committed bytes under `docs/cost-baselines/fixtures/`, and changing one
 * changes the baseline visibly, in a diff, with a reviewer.
 *
 * The scenarios run over the same public contract a client uses — no service
 * is reached into, no repository is called directly. A baseline taken below
 * the API would miss exactly the duplication PR4 removes, because that
 * duplication *is* one flow calling the provider from two request handlers.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ScenarioId } from './artifact';
import { percentile, type ApiResponse, type HttpTarget } from './http-target';
import { FIXTURES_DIR } from './stub-google';

export type Fixtures = {
  seededCatalog: {
    providerPlaceId: string;
    name: string;
    addressText: string;
    lat: number;
    lng: number;
    rating: number;
    ratingCount: number;
    category: string;
  }[];
  A: { title: string; repeat: number; query: string; lat: number; lng: number; expect: string };
  B: { title: string; queries: string[]; lat: number; lng: number; expect: string };
  C1: { title: string; urls: string[]; expect: string };
  C2: { title: string; urls: string[]; expandsTo: Record<string, string>; expect: string };
  D: { title: string; urls: string[]; expect: string };
  E: {
    title: string;
    sheet: string;
    composition: Record<string, number>;
    publish: string;
    expect: string;
  };
  F: {
    title: string;
    matchUrl: string;
    matchesPlaceId: string;
    missUrl: string;
    expect: string;
  };
};

export function loadFixtures(dir: string = FIXTURES_DIR): Fixtures {
  return JSON.parse(readFileSync(path.join(dir, 'scenarios.json'), 'utf8')) as Fixtures;
}

export function loadSheet(fixtures: Fixtures, dir: string = FIXTURES_DIR): Buffer {
  return readFileSync(path.join(dir, fixtures.E.sheet));
}

/** Who the scenarios act as. Roles matter: publish is ops-only, decide is moderator. */
export type BaselineActors = { user: string; moderator: string; ops: string };

export type ScenarioOutcome = {
  /** Recorded per §4's correctness column; a cheap run that broke the flow fails here. */
  assertions: { name: string; expected: string; actual: string; pass: boolean }[];
  rowsCreated: number;
  rowsDeduped: number;
  rowsRejected: number;
  /** URLs that carried a `place_id` and needed no request to learn it. */
  noNetworkResolutions: number;
  apiDurationsMs: number[];
  apiNon2xx: number;
};

export type ScenarioContext = {
  http: HttpTarget;
  fixtures: Fixtures;
  actors: BaselineActors;
  fixturesDir: string;
  /**
   * Run the worker until it has nothing left to advance.
   *
   * Supplied by the harness because "the worker ran" means different things in
   * the two transports: in-process it is `PlaceImportJobService.processPendingJobs`
   * called directly; against a deployed environment it is waiting for the real
   * worker's poll interval. The provider calls it makes land in the same
   * ledger either way, which is the only thing the baseline needs to be true.
   */
  advanceWorker(): Promise<void>;
};

export type Scenario = {
  id: ScenarioId;
  title: string;
  pinnedInput: string;
  run(ctx: ScenarioContext): Promise<ScenarioOutcome>;
};

/** Accumulates the bookkeeping every scenario shares, so none of them forgets it. */
class Recorder {
  readonly assertions: ScenarioOutcome['assertions'] = [];
  readonly apiDurationsMs: number[] = [];
  apiNon2xx = 0;
  rowsCreated = 0;
  rowsDeduped = 0;
  rowsRejected = 0;
  noNetworkResolutions = 0;

  constructor(private readonly http: HttpTarget) {}

  async call(req: Parameters<HttpTarget['request']>[0]): Promise<ApiResponse> {
    const res = await this.http.request(req);
    this.apiDurationsMs.push(res.durationMs);
    if (res.status < 200 || res.status >= 300) this.apiNon2xx += 1;
    return res;
  }

  expect(name: string, expected: unknown, actual: unknown): void {
    const e = format(expected);
    const a = format(actual);
    this.assertions.push({ name, expected: e, actual: a, pass: e === a });
  }

  done(): ScenarioOutcome {
    return {
      assertions: this.assertions,
      rowsCreated: this.rowsCreated,
      rowsDeduped: this.rowsDeduped,
      rowsRejected: this.rowsRejected,
      noNetworkResolutions: this.noNetworkResolutions,
      apiDurationsMs: this.apiDurationsMs,
      apiNon2xx: this.apiNon2xx,
    };
  }
}

function format(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** A URL that already names the place needs no request to resolve (§4). */
function carriesPlaceId(url: string): boolean {
  return /[?&]place_id=([\w-]+)/.test(url);
}

// ── A · known GoGo search hit ────────────────────────────────────────────────

const scenarioA: Scenario = {
  id: 'A',
  title: 'known GoGo search hit',
  pinnedInput: 'scenarios.json#A',
  async run({ http, fixtures }) {
    const rec = new Recorder(http);
    const { query, lat, lng, repeat } = fixtures.A;
    const seen = new Set<string>();
    const reasons = new Set<string>();

    for (let i = 0; i < repeat; i += 1) {
      const res = await rec.call({
        method: 'GET',
        url: `/v1/places/search?q=${encodeURIComponent(query)}&lat=${lat}&lng=${lng}`,
      });
      const body = res.body as { results?: { id?: string; reasonCodes?: string[] }[] };
      const top = body.results?.[0];
      seen.add(String(top?.id ?? 'none'));
      reasons.add(JSON.stringify(top?.reasonCodes ?? []));
    }

    // The plan's correctness column: "same top result id and reasonCodes". A
    // set of one is the assertion — ten identical answers, not ten answers
    // that happened to be non-empty.
    rec.expect('same top result across every repeat', 1, seen.size);
    rec.expect('same reasonCodes across every repeat', 1, reasons.size);
    rec.expect('top result is a catalog hit, not empty', false, seen.has('none'));
    return rec.done();
  },
};

// ── B · unknown GoGo text search ────────────────────────────────────────────

const scenarioB: Scenario = {
  id: 'B',
  title: 'unknown GoGo text search',
  pinnedInput: 'scenarios.json#B',
  async run({ http, fixtures }) {
    const rec = new Recorder(http);
    const { queries, lat, lng } = fixtures.B;
    let empty = 0;

    for (const q of queries) {
      const res = await rec.call({
        method: 'GET',
        url: `/v1/places/search?q=${encodeURIComponent(q)}&lat=${lat}&lng=${lng}`,
      });
      const body = res.body as { results?: unknown[] };
      if ((body.results ?? []).length === 0) empty += 1;
    }

    rec.expect('every pinned nonsense query returns empty', queries.length, empty);
    // Today a miss stops at the catalog: nothing reaches Google until PR10
    // turns discovery on. The operations table is where that is *proved* —
    // this only records the product outcome beside it.
    rec.expect('no rows created by a search miss', 0, rec.rowsCreated);
    return rec.done();
  },
};

// ── C · import a Google place GoGo already has ──────────────────────────────

async function importAlreadyKnown(
  ctx: ScenarioContext,
  urls: string[],
  rec: Recorder,
): Promise<void> {
  let alreadyExists = 0;
  const existingIds = new Set<string>();

  for (const url of urls) {
    if (carriesPlaceId(url)) rec.noNetworkResolutions += 1;
    const resolved = await rec.call({
      method: 'POST',
      url: '/v1/places/resolve-google-maps-link',
      payload: { url },
    });
    const body = resolved.body as {
      status?: string;
      existingPlaceId?: string;
      candidate?: { googlePlaceId?: string; providerPlaceId?: string };
    };
    if (body.status === 'ALREADY_EXISTS') {
      alreadyExists += 1;
      rec.rowsDeduped += 1;
      if (body.existingPlaceId) existingIds.add(body.existingPlaceId);
    }

    const googlePlaceId =
      body.candidate?.googlePlaceId ??
      body.candidate?.providerPlaceId ??
      /[?&]place_id=([\w-]+)/.exec(url)?.[1];
    if (!googlePlaceId) continue;

    // The submit half of the flow. Today it re-fetches; PR4's attestation is
    // what removes that, so the BEFORE run has to include it.
    const submitted = await rec.call({
      method: 'POST',
      url: '/v1/place-submissions',
      token: ctx.actors.user,
      payload: { googlePlaceId },
    });
    const sub = submitted.body as { status?: string; placeId?: string; deduped?: boolean };
    if (sub.status === 'ALREADY_EXISTS' || sub.deduped === true) rec.rowsDeduped += 1;
  }

  rec.expect('every pinned link resolves to an existing place', urls.length, alreadyExists);
  rec.expect('each resolves to a distinct catalogued place', urls.length, existingIds.size);
}

const scenarioC1: Scenario = {
  id: 'C1',
  title: 'import Google place already known — direct place_id URL',
  pinnedInput: 'scenarios.json#C1',
  async run(ctx) {
    const rec = new Recorder(ctx.http);
    await importAlreadyKnown(ctx, ctx.fixtures.C1.urls, rec);
    rec.expect(
      'no short-link expansion needed',
      ctx.fixtures.C1.urls.length,
      rec.noNetworkResolutions,
    );
    return rec.done();
  },
};

const scenarioC2: Scenario = {
  id: 'C2',
  title: 'import Google place already known — maps.app.goo.gl short link',
  pinnedInput: 'scenarios.json#C2',
  async run(ctx) {
    const rec = new Recorder(ctx.http);
    await importAlreadyKnown(ctx, ctx.fixtures.C2.urls, rec);
    // A short link carries no id, so none of these is a no-network resolution.
    // The expansion hop is counted as `google.expand` in the operations table,
    // which is the number PR4 must *not* claim to have removed.
    rec.expect('short links carry no place id', 0, rec.noNetworkResolutions);
    return rec.done();
  },
};

// ── D · import a Google place GoGo does not have ────────────────────────────

const scenarioD: Scenario = {
  id: 'D',
  title: 'import new Google place',
  pinnedInput: 'scenarios.json#D',
  async run(ctx) {
    const rec = new Recorder(ctx.http);
    let approved = 0;
    let attested = 0;

    for (const url of ctx.fixtures.D.urls) {
      if (carriesPlaceId(url)) rec.noNetworkResolutions += 1;

      // 1 · preview
      const resolved = await rec.call({
        method: 'POST',
        url: '/v1/places/resolve-google-maps-link',
        payload: { url },
      });
      const preview = resolved.body as {
        candidate?: { googlePlaceId?: string };
        resolutionToken?: string;
      };
      const googlePlaceId =
        preview.candidate?.googlePlaceId ?? /[?&]place_id=([\w-]+)/.exec(url)?.[1];
      if (!googlePlaceId) {
        rec.rowsRejected += 1;
        continue;
      }
      if (preview.resolutionToken) attested += 1;

      // 2 · submit — carrying the resolve attestation, which is what a PR4
      // client does (#337 / GoGo-MobileApp#128). Without it the server verifies
      // the place with Google a second time, which is the number this scenario
      // exists to move.
      const submitted = await rec.call({
        method: 'POST',
        url: '/v1/place-submissions',
        token: ctx.actors.user,
        payload: {
          googlePlaceId,
          category: 'cafe',
          ...(preview.resolutionToken ? { resolutionToken: preview.resolutionToken } : {}),
        },
      });
      const submissionId = (submitted.body as { submissionId?: string }).submissionId;
      if (!submissionId) {
        rec.rowsRejected += 1;
        continue;
      }

      // 3 · approve (CMS revalidates before it writes a catalog row)
      const decided = await rec.call({
        method: 'POST',
        url: `/v1/cms/place-submissions/${submissionId}/decide`,
        token: ctx.actors.moderator,
        payload: { decision: 'approved', reason: 'baseline scenario D approval' },
      });
      if (decided.status >= 200 && decided.status < 300) {
        approved += 1;
        rec.rowsCreated += 1;
      } else {
        rec.rowsRejected += 1;
      }
    }

    rec.expect(
      'every pinned new place is approved into the catalog',
      ctx.fixtures.D.urls.length,
      approved,
    );
    rec.expect(
      'every pinned URL named its place id',
      ctx.fixtures.D.urls.length,
      rec.noNetworkResolutions,
    );
    // An operational place must hand back a token, or the submit silently
    // reverts to the second Details call and the saving disappears with no
    // failing assertion to say so (#337).
    rec.expect(
      'every preview issued a resolution attestation',
      ctx.fixtures.D.urls.length,
      attested,
    );
    return rec.done();
  },
};

// ── E · deterministic bulk import ───────────────────────────────────────────

const scenarioE: Scenario = {
  id: 'E',
  title: 'deterministic bulk import — pinned 20-row sheet',
  pinnedInput: 'scenarios.json#E + scenario-e-sheet.csv',
  async run(ctx) {
    const rec = new Recorder(ctx.http);
    const sheet = loadSheet(ctx.fixtures, ctx.fixturesDir);
    const { body, contentType } = multipart([
      { name: 'file', filename: 'scenario-e-sheet.csv', contentType: 'text/csv', value: sheet },
      { name: 'mode', value: Buffer.from('create_drafts') },
      { name: 'defaultCity', value: Buffer.from('Hồ Chí Minh') },
    ]);

    const created = await rec.call({
      method: 'POST',
      url: '/v1/cms/place-imports',
      token: ctx.actors.ops,
      raw: { body, contentType },
    });
    const jobId = (created.body as { id?: string }).id;
    if (!jobId) {
      rec.expect('import job created', true, false);
      return rec.done();
    }

    // `start` only flips the job to `processing` — the **worker** advances it
    // in chunks (OpenAPI: "the worker advances it in chunks of 50 rows"). The
    // scenario therefore starts the job over the API, as an operator does,
    // and then asks the harness to let the worker run. Doing the resolution
    // from inside this file would measure a code path no deployment uses.
    await rec.call({
      method: 'POST',
      url: `/v1/cms/place-imports/${jobId}/start`,
      token: ctx.actors.ops,
    });
    await ctx.advanceWorker();

    const rows = await rec.call({
      method: 'GET',
      url: `/v1/cms/place-imports/${jobId}/rows?limit=100&offset=0`,
      token: ctx.actors.ops,
    });
    const items = (
      (rows.body as { items?: { id?: string; status?: string }[] })?.items ?? []
    ).filter((r): r is { id: string; status: string } => Boolean(r.id && r.status));
    const byStatus = new Map<string, number>();
    for (const row of items) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);

    const ready = items.filter((r) => r.status === 'ready').map((r) => r.id);
    const published = await rec.call({
      method: 'POST',
      url: `/v1/cms/place-imports/${jobId}/publish`,
      token: ctx.actors.ops,
      payload: { rowIds: ready },
    });
    const publishBody = published.body as { created?: number; failed?: unknown[] };

    rec.rowsCreated = publishBody.created ?? 0;
    rec.rowsDeduped = byStatus.get('duplicate') ?? 0;
    // `ingest_row_status` (libs/database/src/schema/ingestion.ts): a row that
    // will never become a place is `validation_failed`, `unresolved` or
    // `failed`. `needs_confirmation` is not rejected — it is waiting for an
    // editor — so it is counted apart rather than folded in.
    rec.rowsRejected =
      (byStatus.get('validation_failed') ?? 0) +
      (byStatus.get('unresolved') ?? 0) +
      (byStatus.get('failed') ?? 0);

    // §4's correctness column for E is the row-outcome mix, not the total.
    // Two runs that both imported "fifteen rows" but disagreed about which
    // fifteen would compare equal on a count and be a different experiment.
    const expected = ctx.fixtures.E.composition;
    const total = Object.values(expected).reduce((a, b) => a + b, 0);
    rec.expect('every sheet row is accounted for', total, items.length);
    // The two pinned junk URLs must never become importable. Asserted on the
    // outcome rather than on one status name, because "rejected" is spread
    // across `validation_failed` and `unresolved` depending on whether the
    // host or the lookup refused it — and which one it is is a detail the
    // baseline should not freeze.
    const notImportable =
      total -
      (byStatus.get('ready') ?? 0) -
      (byStatus.get('imported') ?? 0) -
      (byStatus.get('duplicate') ?? 0) -
      (byStatus.get('needs_confirmation') ?? 0);
    rec.expect('invalid URLs never become importable', expected.invalid, notImportable);
    // Recorded, not asserted: §4's target for E is a range, so pinning one
    // exact mix here would freeze an arbitrary point of it as the only correct
    // answer. `compare.ts` is what holds two runs to each other.
    rec.expect('row outcome mix', outcomeMix(byStatus), outcomeMix(byStatus));
    rec.expect(
      'publish created a place for every ready row',
      ready.length,
      publishBody.created ?? 0,
    );
    return rec.done();
  },
};

/**
 * The mix, rendered stably.
 *
 * Recorded rather than asserted against a hard-coded expectation: the plan's
 * §4 target for E is a *range* (`details.quality ≈ 13 + (5..15)`), so pinning
 * an exact mix here would encode one arbitrary point of it as correct. Two
 * runs are compared against each other by `compare.ts`, which is the property
 * the plan actually states.
 */
function outcomeMix(byStatus: Map<string, number>): string {
  return [...byStatus.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${status}=${count}`)
    .join(' ');
}

/**
 * Minimal multipart encoder.
 *
 * A dependency for this would be a dependency shipped to production for a
 * script, and the format is four lines of RFC 7578. The boundary is fixed
 * rather than random — a baseline that changed one byte of its request between
 * runs would be a baseline that could not claim determinism.
 */
export function multipart(
  parts: { name: string; filename?: string; contentType?: string; value: Buffer }[],
): { body: Buffer; contentType: string } {
  const boundary = '----gogoCostBaselineBoundary336';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    const headers =
      `--${boundary}\r\nContent-Disposition: ${disposition}\r\n` +
      (part.contentType ? `Content-Type: ${part.contentType}\r\n` : '') +
      '\r\n';
    chunks.push(Buffer.from(headers, 'utf8'), part.value, Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** In plan order. A is first because it must run on an unpolluted catalog. */
// ── F · resolve a link that states its identity ─────────────────────────────

/**
 * COST-BE-003 / GoGo-BE#505 — the paid identity search, priced.
 *
 * Every other scenario here hands the resolver a `?place_id=` URL, so none of
 * them reaches the branch a real share link takes: a `ftid` the resolver has
 * to *find* among Google's hits. That branch buys a different SKU — Text
 * Search **Pro**, because `places.googleMapsUri` is a Pro field — and a paid
 * SKU with no scenario is an unmeasured one.
 *
 * The pinned link names the **fifth** of ten hits, which is the case the whole
 * mechanism exists for: three Enterprise Details cannot reach it and ten would
 * cost $200/1,000. One Pro search reads all ten CIDs and one Details is bought.
 *
 * The second URL states a CID none of the ten carries. That is the failure
 * path, and what it must cost is *one search and nothing else*: candidates
 * that publish CIDs and do not match are provably not the place, so buying
 * Details for them would be paying to build a list nobody should pick from.
 */
const scenarioF: Scenario = {
  id: 'F',
  title: 'resolve a share link by the identity it states (ftid → CID)',
  pinnedInput: 'scenarios.json#F',
  async run(ctx) {
    const rec = new Recorder(ctx.http);

    const matched = await rec.call({
      method: 'POST',
      url: '/v1/places/resolve-google-maps-link',
      payload: { url: ctx.fixtures.F.matchUrl },
    });
    const match = matched.body as {
      status?: string;
      reasonCodes?: string[];
      candidate?: { googlePlaceId?: string };
    };
    rec.expect('the link resolves', 'RESOLVED', match.status ?? '(none)');
    rec.expect(
      'to the place its CID names, not the one ranked first',
      ctx.fixtures.F.matchesPlaceId,
      match.candidate?.googlePlaceId ?? '(none)',
    );
    rec.expect(
      'and says the identity is what decided it',
      true,
      (match.reasonCodes ?? []).includes('CID_EXACT_MATCH'),
    );
    if (match.status === 'RESOLVED') rec.rowsCreated += 1;

    const missed = await rec.call({
      method: 'POST',
      url: '/v1/places/resolve-google-maps-link',
      payload: { url: ctx.fixtures.F.missUrl },
    });
    const miss = missed.body as { status?: string; reasonCodes?: string[] };
    rec.expect('a CID in none of the hits does not resolve', 'UNRESOLVED', miss.status ?? '(none)');
    rec.expect(
      'and says why, rather than offering places the link contradicts',
      true,
      (miss.reasonCodes ?? []).includes('CID_NOT_IN_CANDIDATES'),
    );
    if (miss.status !== 'RESOLVED') rec.rowsRejected += 1;

    // Neither URL carries a `place_id`, so neither is a no-network resolution:
    // the identity had to be looked up, which is what this scenario prices.
    rec.expect('neither URL named a place id outright', 0, rec.noNetworkResolutions);
    return rec.done();
  },
};

export const SCENARIOS: readonly Scenario[] = [
  scenarioA,
  scenarioB,
  scenarioC1,
  scenarioC2,
  scenarioD,
  scenarioE,
  scenarioF,
];

export { percentile };
